const zohoAuth = require('../lib/zohoAuth');

const SUPABASE_URL = 'https://xfdfbrfudsaxqgpsdboa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmZGZicmZ1ZHNheHFncHNkYm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTA1MzgsImV4cCI6MjA5NzM2NjUzOH0.sfUC5Mn_d7-FGkvQHyD01kdGM81TjG4VWzXoFv43n94';
const DASHBOARD_TABLE_URL = `${SUPABASE_URL}/rest/v1/dashboard_data`;
const PM_ROW_ID = 'pm';

const NAGENDRAN_OWNER_ID = '1870461000070455183'; // Nagendran K
const FY_START = '2026-04-01T00:00:00+05:30'; // FY2026-27

const MONTH_NAMES = ['', 'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function getISTYearMonth(isoString) {
  const match = (isoString || '').match(/^(\d{4})-(\d{2})-\d{2}/);
  if (!match) return null;
  return { year: parseInt(match[1], 10), month: parseInt(match[2], 10) };
}

// Generic cursor-paginated fetch against any Zoho module, filtered by Created_Time.
async function fetchAllSince(moduleName, fields, accessToken, apiDomain) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  let records = [];
  let page = 1;
  let pageToken = null;
  let more = true;
  const sinceDate = new Date(FY_START);
  const MAX_ITER = 200; // safety cap
  let iter = 0;

  while (more && iter < MAX_ITER) {
    iter++;
    let url = `${apiDomain}/crm/v8/${moduleName}?fields=${fields}&per_page=200&sort_by=Created_Time&sort_order=desc`;
    url += pageToken ? `&page_token=${pageToken}` : `&page=${page}`;
    const res = await fetch(url, { headers: authHeader });
    if (res.status === 204) break;
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Zoho ${moduleName} fetch failed: ${res.status} ${errText}`);
    }
    const data = await res.json();
    const pageRecords = data.data || [];
    if (!pageRecords.length) break;

    const cutoffHit = pageRecords.some(r => {
      const ct = r.Created_Time;
      return ct && new Date(ct) < sinceDate;
    });
    if (cutoffHit) {
      records = records.concat(pageRecords.filter(r => r.Created_Time && new Date(r.Created_Time) >= sinceDate));
      break;
    }
    records = records.concat(pageRecords);
    more = data.info?.more_records || false;
    pageToken = data.info?.next_page_token || null;
    page++;
  }
  return records;
}

// Fetch every Product whose Product_Basket matches one of the given values.
async function fetchTargetProductIds(basketValues, accessToken, apiDomain) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const ids = new Set();
  for (const basket of basketValues) {
    let page = 1;
    let more = true;
    while (more) {
      const criteria = encodeURIComponent(`(Product_Basket:equals:${basket})`);
      const url = `${apiDomain}/crm/v8/Products/search?criteria=${criteria}&fields=id&per_page=200&page=${page}`;
      const res = await fetch(url, { headers: authHeader });
      if (res.status === 204) break;
      if (!res.ok) { more = false; break; }
      const data = await res.json();
      (data.data || []).forEach(p => ids.add(p.id));
      more = data.info?.more_records || false;
      page++;
    }
  }
  return ids;
}

// Fetch Owner for every parent Sales_Orders/Invoices record in the FY window,
// returning a Set of record IDs that should be EXCLUDED (owned by Nagendran K).
async function fetchExcludedParentIds(moduleName, accessToken, apiDomain) {
  const records = await fetchAllSince(moduleName, 'id,Owner,Created_Time', accessToken, apiDomain);
  const excluded = new Set();
  records.forEach(r => {
    if (r.Owner && r.Owner.id === NAGENDRAN_OWNER_ID) excluded.add(r.id);
  });
  return excluded;
}

// Aggregate a line-item module (Ordered_Items / Invoiced_Items) into monthly
// totals (in Lakhs), restricted to the target products and excluding any
// line item whose parent record is owned by Nagendran K.
async function aggregateMonthly(moduleName, accessToken, apiDomain, targetProductIds, excludedParentIds) {
  const items = await fetchAllSince(moduleName, 'Product_Name,Net_Total,Created_Time,Parent_Id', accessToken, apiDomain);
  const monthly = {};
  let matchedCount = 0;
  items.forEach(item => {
    const productId = item.Product_Name?.id;
    const parentId = item.Parent_Id?.id;
    if (!productId || !targetProductIds.has(productId)) return;
    if (parentId && excludedParentIds.has(parentId)) return;
    const ym = getISTYearMonth(item.Created_Time);
    if (!ym) return;
    const monthLabel = MONTH_NAMES[ym.month];
    monthly[monthLabel] = (monthly[monthLabel] || 0) + (item.Net_Total || 0) / 100000; // convert to Lakhs
    matchedCount++;
  });
  return { monthly, matchedCount, totalFetched: items.length };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const accessToken = await zohoAuth.getZohoAccessToken();
    const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';

    const targetProductIds = await fetchTargetProductIds(['Prepaid', 'Smart Meters'], accessToken, apiDomain);
    const excludedOrders = await fetchExcludedParentIds('Sales_Orders', accessToken, apiDomain);
    const excludedInvoices = await fetchExcludedParentIds('Invoices', accessToken, apiDomain);

    const obResult = await aggregateMonthly('Ordered_Items', accessToken, apiDomain, targetProductIds, excludedOrders);
    const invResult = await aggregateMonthly('Invoiced_Items', accessToken, apiDomain, targetProductIds, excludedInvoices);

    // Read the existing 'pm' row so we only touch obActuals/invActuals, preserving everything else
    const getRes = await fetch(`${DASHBOARD_TABLE_URL}?id=eq.${PM_ROW_ID}&select=payload`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!getRes.ok) throw new Error(`Supabase read failed: ${getRes.status}`);
    const rows = await getRes.json();
    const existingPayload = rows[0]?.payload || {};

    const roundedOB = Object.fromEntries(Object.entries(obResult.monthly).map(([k,v]) => [k, Math.round(v*10)/10]));
    const roundedInv = Object.fromEntries(Object.entries(invResult.monthly).map(([k,v]) => [k, Math.round(v*10)/10]));

    const newPayload = {
      ...existingPayload,
      obActuals: roundedOB,
      invActuals: roundedInv,
      updatedAt: new Date().toISOString()
    };

    const putRes = await fetch(DASHBOARD_TABLE_URL, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ id: PM_ROW_ID, payload: newPayload, updated_at: newPayload.updatedAt })
    });
    if (!putRes.ok) {
      const errText = await putRes.text();
      throw new Error(`Supabase write failed: ${putRes.status} ${errText}`);
    }

    res.status(200).json({
      targetProductCount: targetProductIds.size,
      excludedOrdersCount: excludedOrders.size,
      excludedInvoicesCount: excludedInvoices.size,
      obActuals: roundedOB,
      invActuals: roundedInv,
      obDiagnostics: { matchedLineItems: obResult.matchedCount, totalLineItemsScanned: obResult.totalFetched },
      invDiagnostics: { matchedLineItems: invResult.matchedCount, totalLineItemsScanned: invResult.totalFetched },
      writtenAt: newPayload.updatedAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
