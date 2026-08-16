const zohoAuth = require('../lib/zohoAuth');

const SUPABASE_URL = 'https://xfdfbrfudsaxqgpsdboa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmZGZicmZ1ZHNheHFncHNkYm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTA1MzgsImV4cCI6MjA5NzM2NjUzOH0.sfUC5Mn_d7-FGkvQHyD01kdGM81TjG4VWzXoFv43n94';
const DASHBOARD_TABLE_URL = `${SUPABASE_URL}/rest/v1/dashboard_data`;
const PM_ROW_ID = 'pm';
const CURSOR_ROW_ID = 'pm-prepaid-sync-cursor';

const NAGENDRAN_OWNER_ID = '1870461000070455183';
const FY_START = '2026-04-01T00:00:00+05:30';
const MONTH_NAMES = ['', 'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const TIME_BUDGET_MS = 52000; // stop well before Vercel's 60s hard limit, save progress, let the next call resume

function getISTYearMonth(isoString) {
  const match = (isoString || '').match(/^(\d{4})-(\d{2})-\d{2}/);
  if (!match) return null;
  return { year: parseInt(match[1], 10), month: parseInt(match[2], 10) };
}

async function getCursor() {
  const res = await fetch(`${DASHBOARD_TABLE_URL}?id=eq.${CURSOR_ROW_ID}&select=payload`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase cursor read failed: ${res.status}`);
  const rows = await res.json();
  return rows[0]?.payload || null;
}

async function saveCursor(state) {
  const res = await fetch(DASHBOARD_TABLE_URL, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({ id: CURSOR_ROW_ID, payload: state, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error(`Supabase cursor save failed: ${res.status}`);
}

async function clearCursor() {
  await fetch(`${DASHBOARD_TABLE_URL}?id=eq.${CURSOR_ROW_ID}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
}

function freshState() {
  return {
    stage: 'products',
    targetProductIds: null,
    excludedOrderIds: null,
    excludedInvoiceIds: null,
    obMonthly: {}, obMatched: 0, obScanned: 0,
    invMonthly: {}, invMatched: 0, invScanned: 0,
    page: 1, pageToken: null,
    basketIndex: 0
  };
}

async function stepProducts(state, accessToken, apiDomain, deadline) {
  const basketValues = ['Prepaid', 'Smart Meters'];
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const ids = new Set(state.targetProductIds || []);

  while (state.basketIndex < basketValues.length) {
    if (Date.now() > deadline) return false;
    const basket = basketValues[state.basketIndex];
    const criteria = encodeURIComponent(`(Product_Basket:equals:${basket})`);
    const url = `${apiDomain}/crm/v8/Products/search?criteria=${criteria}&fields=id&per_page=200&page=${state.page}`;
    const res = await fetch(url, { headers: authHeader });
    if (res.status === 204) { state.basketIndex++; state.page = 1; continue; }
    if (!res.ok) throw new Error(`Products search failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    (data.data || []).forEach(p => ids.add(p.id));
    if (data.info?.more_records) {
      state.page++;
    } else {
      state.basketIndex++;
      state.page = 1;
    }
  }
  state.targetProductIds = [...ids];
  return true;
}

async function stepExcludedParents(state, moduleName, idsFieldName, accessToken, apiDomain, deadline) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const ids = new Set(state[idsFieldName] || []);
  const sinceDate = new Date(FY_START);

  while (Date.now() < deadline) {
    let url = `${apiDomain}/crm/v8/${moduleName}?fields=id,Owner,Created_Time&per_page=200&sort_by=Created_Time&sort_order=desc`;
    url += state.pageToken ? `&page_token=${state.pageToken}` : `&page=${state.page}`;
    const res = await fetch(url, { headers: authHeader });
    if (res.status === 204) break;
    if (!res.ok) throw new Error(`${moduleName} fetch failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const pageRecords = data.data || [];
    if (!pageRecords.length) break;

    let hitCutoff = false;
    pageRecords.forEach(r => {
      if (r.Created_Time && new Date(r.Created_Time) < sinceDate) { hitCutoff = true; return; }
      if (r.Owner && r.Owner.id === NAGENDRAN_OWNER_ID) ids.add(r.id);
    });
    state[idsFieldName] = [...ids];
    if (hitCutoff || !data.info?.more_records) {
      state.page = 1; state.pageToken = null;
      return true;
    }
    state.pageToken = data.info?.next_page_token || null;
    state.page++;
  }
  state[idsFieldName] = [...ids];
  return false;
}

async function stepAggregateItems(state, moduleName, monthlyField, matchedField, scannedField, targetProductIds, excludedParentIds, accessToken, apiDomain, deadline) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const sinceDate = new Date(FY_START);
  const targetSet = new Set(targetProductIds);
  const excludedSet = new Set(excludedParentIds);

  while (Date.now() < deadline) {
    let url = `${apiDomain}/crm/v8/${moduleName}?fields=Product_Name,Net_Total,Created_Time,Parent_Id&per_page=200&sort_by=Created_Time&sort_order=desc`;
    url += state.pageToken ? `&page_token=${state.pageToken}` : `&page=${state.page}`;
    const res = await fetch(url, { headers: authHeader });
    if (res.status === 204) break;
    if (!res.ok) throw new Error(`${moduleName} fetch failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const pageRecords = data.data || [];
    if (!pageRecords.length) break;

    let hitCutoff = false;
    pageRecords.forEach(item => {
      if (item.Created_Time && new Date(item.Created_Time) < sinceDate) { hitCutoff = true; return; }
      state[scannedField]++;
      const productId = item.Product_Name?.id;
      const parentId = item.Parent_Id?.id;
      if (!productId || !targetSet.has(productId)) return;
      if (parentId && excludedSet.has(parentId)) return;
      const ym = getISTYearMonth(item.Created_Time);
      if (!ym) return;
      const monthLabel = MONTH_NAMES[ym.month];
      state[monthlyField][monthLabel] = (state[monthlyField][monthLabel] || 0) + (item.Net_Total || 0) / 100000;
      state[matchedField]++;
    });

    if (hitCutoff || !data.info?.more_records) {
      state.page = 1; state.pageToken = null;
      return true;
    }
    state.pageToken = data.info?.next_page_token || null;
    state.page++;
  }
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const startTime = Date.now();
  const deadline = startTime + TIME_BUDGET_MS;

  try {
    const forceRestart = req.query?.restart === '1';
    let state = forceRestart ? null : await getCursor();

    // If there's no in-progress cursor, check whether today's sync already
    // completed - if so, skip entirely rather than starting a brand new
    // full recompute (avoids wasteful/duplicate re-runs from the multiple
    // scheduled attempts each morning).
    if (!state && !forceRestart) {
      const getRes = await fetch(`${DASHBOARD_TABLE_URL}?id=eq.${PM_ROW_ID}&select=payload`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
      });
      if (getRes.ok) {
        const rows = await getRes.json();
        const lastUpdated = rows[0]?.payload?.updatedAt;
        if (lastUpdated) {
          // Compare IST calendar dates (UTC+5:30) so "today" matches the
          // morning cron's local sense of day, not the server's UTC date.
          const istOffsetMs = 5.5 * 60 * 60 * 1000;
          const todayIST = new Date(Date.now() + istOffsetMs).toISOString().slice(0, 10);
          const lastUpdatedIST = new Date(new Date(lastUpdated).getTime() + istOffsetMs).toISOString().slice(0, 10);
          if (lastUpdatedIST === todayIST) {
            return res.status(200).json({
              complete: true, skipped: true,
              message: `Already synced today (${lastUpdatedIST}) - skipping redundant re-run.`,
              lastUpdated
            });
          }
        }
      }
    }

    if (!state) state = freshState();

    const accessToken = await zohoAuth.getZohoAccessToken();
    const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';

    if (state.stage === 'products') {
      const done = await stepProducts(state, accessToken, apiDomain, deadline);
      if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: state.stage, message: 'Fetching target products, run again to continue.' }); }
      state.stage = 'excludedOrders';
    }

    if (state.stage === 'excludedOrders') {
      const done = await stepExcludedParents(state, 'Sales_Orders', 'excludedOrderIds', accessToken, apiDomain, deadline);
      if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: state.stage, excludedSoFar: state.excludedOrderIds.length, message: 'Scanning Sales Orders for Nagendran exclusions, run again to continue.' }); }
      state.stage = 'excludedInvoices';
    }

    if (state.stage === 'excludedInvoices') {
      const done = await stepExcludedParents(state, 'Invoices', 'excludedInvoiceIds', accessToken, apiDomain, deadline);
      if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: state.stage, excludedSoFar: state.excludedInvoiceIds.length, message: 'Scanning Invoices for Nagendran exclusions, run again to continue.' }); }
      state.stage = 'obItems';
    }

    if (state.stage === 'obItems') {
      const done = await stepAggregateItems(state, 'Ordered_Items', 'obMonthly', 'obMatched', 'obScanned', state.targetProductIds, state.excludedOrderIds, accessToken, apiDomain, deadline);
      if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: state.stage, scannedSoFar: state.obScanned, matchedSoFar: state.obMatched, obMonthlySoFar: state.obMonthly, message: 'Aggregating Order Booking line items, run again to continue.' }); }
      state.stage = 'invItems';
    }

    if (state.stage === 'invItems') {
      const done = await stepAggregateItems(state, 'Invoiced_Items', 'invMonthly', 'invMatched', 'invScanned', state.targetProductIds, state.excludedInvoiceIds, accessToken, apiDomain, deadline);
      if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: state.stage, scannedSoFar: state.invScanned, matchedSoFar: state.invMatched, invMonthlySoFar: state.invMonthly, message: 'Aggregating Invoicing line items, run again to continue.' }); }
      state.stage = 'done';
    }

    const getRes = await fetch(`${DASHBOARD_TABLE_URL}?id=eq.${PM_ROW_ID}&select=payload`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!getRes.ok) throw new Error(`Supabase read failed: ${getRes.status}`);
    const rows = await getRes.json();
    const existingPayload = rows[0]?.payload || {};

    const roundedOB = Object.fromEntries(Object.entries(state.obMonthly).map(([k,v]) => [k, Math.round(v*10)/10]));
    const roundedInv = Object.fromEntries(Object.entries(state.invMonthly).map(([k,v]) => [k, Math.round(v*10)/10]));

    const newPayload = { ...existingPayload, obActuals: roundedOB, invActuals: roundedInv, updatedAt: new Date().toISOString() };

    const putRes = await fetch(DASHBOARD_TABLE_URL, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: PM_ROW_ID, payload: newPayload, updated_at: newPayload.updatedAt })
    });
    if (!putRes.ok) throw new Error(`Supabase write failed: ${putRes.status} ${await putRes.text()}`);

    await clearCursor();

    res.status(200).json({
      complete: true,
      targetProductCount: state.targetProductIds.length,
      excludedOrdersCount: state.excludedOrderIds.length,
      excludedInvoicesCount: state.excludedInvoiceIds.length,
      obActuals: roundedOB,
      invActuals: roundedInv,
      obDiagnostics: { matchedLineItems: state.obMatched, totalLineItemsScanned: state.obScanned },
      invDiagnostics: { matchedLineItems: state.invMatched, totalLineItemsScanned: state.invScanned },
      writtenAt: newPayload.updatedAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
