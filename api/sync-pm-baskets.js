// Auto-syncs OB (Order Booking) & Invoicing actuals, plus the underlying
// order/invoice-level details, for the LVS, Panel Meters, ATES, ACCL and FDP
// tabs on the PM Review dashboard.
//
// Unlike Prepaid, these 5 tabs do NOT exclude any particular owner's Sales
// Orders/Invoices - every matching order/invoice line item counts, by design
// (confirmed with the business owner).
//
// Matches Zoho CRM Products by their (free-text) Product_Basket field:
//   lvs   -> "SWITCHGEAR"
//   panel -> "Panel Meters", "Panel Meters Gen-3.0"
//   ates  -> "Transfer Switch", "Switch Transfer", "Ates", "ATeS Motorised"
//   accl  -> "ACCL", "ACCL-1Ph", "ACCL-3Ph"
//   fdp   -> "FDP"
//
// Stores both the monthly totals (obActuals/invActuals) AND the individual
// matching orders/invoices per month (obDetails/invDetails, with account
// names pre-resolved) so the dashboard's click-to-drill-down popup can read
// straight from Supabase instead of doing a slow live Zoho query per click.
const zohoAuth = require('../lib/zohoAuth');

const SUPABASE_URL = 'https://xfdfbrfudsaxqgpsdboa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmZGZicmZ1ZHNheHFncHNkYm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTA1MzgsImV4cCI6MjA5NzM2NjUzOH0.sfUC5Mn_d7-FGkvQHyD01kdGM81TjG4VWzXoFv43n94';
const DASHBOARD_TABLE_URL = `${SUPABASE_URL}/rest/v1/PM_Desk`;
const CURSOR_ROW_ID = 'pm-baskets-sync-cursor';

const FY_START = '2026-04-01T00:00:00+05:30';
const MONTH_NAMES = ['', 'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const TIME_BUDGET_MS = 52000;

const PRODUCT_CONFIGS = [
  { key: 'lvs',   baskets: ['SWITCHGEAR'] },
  { key: 'panel', baskets: ['Panel Meters', 'Panel Meters Gen-3.0'] },
  { key: 'ates',  baskets: ['Transfer Switch', 'Switch Transfer', 'Ates', 'ATeS Motorised'] },
  { key: 'accl',  baskets: ['ACCL', 'ACCL-1Ph', 'ACCL-3Ph'] },
  { key: 'fdp',   baskets: ['FDP'] }
];

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
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: CURSOR_ROW_ID, payload: state, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error(`Supabase cursor save failed: ${res.status}`);
}
async function clearCursor() {
  await fetch(`${DASHBOARD_TABLE_URL}?id=eq.${CURSOR_ROW_ID}`, { method: 'DELETE', headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
}

async function getProductRow(productKey) {
  const res = await fetch(`${DASHBOARD_TABLE_URL}?id=eq.${productKey}&select=payload,updated_at`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase read failed for ${productKey}: ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

function isTodayIST(isoTimestamp) {
  if (!isoTimestamp) return false;
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const todayIST = new Date(Date.now() + istOffsetMs).toISOString().slice(0, 10);
  const stampIST = new Date(new Date(isoTimestamp).getTime() + istOffsetMs).toISOString().slice(0, 10);
  return todayIST === stampIST;
}

function round1(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Math.round(v * 10) / 10]));
}

function attachAccountNames(detailsByMonth, accountNames) {
  const out = {};
  Object.entries(detailsByMonth).forEach(([month, arr]) => {
    out[month] = arr.map(d => ({
      account: accountNames[d.parentId] || '—',
      value: d.value, date: d.date, product: d.product, orderId: d.parentId
    })).sort((a, b) => new Date(b.date) - new Date(a.date));
  });
  return out;
}

async function writeTabResult(productKey, obActuals, invActuals, obDetails, invDetails) {
  const existingRow = await getProductRow(productKey);
  const existingPayload = existingRow?.payload || {};
  const updatedAt = new Date().toISOString();
  const newPayload = { ...existingPayload, obActuals, invActuals, obDetails, invDetails, updatedAt };

  const res = await fetch(DASHBOARD_TABLE_URL, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: productKey, payload: newPayload, updated_at: updatedAt })
  });
  if (!res.ok) throw new Error(`Supabase write failed for ${productKey}: ${res.status} ${await res.text()}`);
  return updatedAt;
}

function freshTabState() {
  return {
    stage: 'products',
    targetProductIds: null,
    obMonthly: {}, obDetails: {}, obMatched: 0, obScanned: 0,
    invMonthly: {}, invDetails: {}, invMatched: 0, invScanned: 0,
    page: 1, pageToken: null,
    basketIndex: 0,
    accountNames: {}, accountNamesPending: null, accountNamesPage: 0
  };
}

function freshState() {
  return { tabIndex: 0, tab: freshTabState() };
}

async function stepProducts(tab, basketValues, accessToken, apiDomain, deadline) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const ids = new Set(tab.targetProductIds || []);
  while (tab.basketIndex < basketValues.length) {
    if (Date.now() > deadline) { tab.targetProductIds = [...ids]; return false; }
    const basket = basketValues[tab.basketIndex];
    const criteria = encodeURIComponent(`(Product_Basket:equals:${basket})`);
    const url = `${apiDomain}/crm/v8/Products/search?criteria=${criteria}&fields=id&per_page=200&page=${tab.page}`;
    const res = await fetch(url, { headers: authHeader });
    if (res.status === 204) { tab.basketIndex++; tab.page = 1; continue; }
    if (!res.ok) throw new Error(`Products search failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    (data.data || []).forEach(p => ids.add(p.id));
    if (data.info?.more_records) { tab.page++; } else { tab.basketIndex++; tab.page = 1; }
  }
  tab.targetProductIds = [...ids];
  return true;
}

async function stepAggregateItems(tab, moduleName, monthlyField, detailsField, matchedField, scannedField, targetProductIds, accessToken, apiDomain, deadline) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const sinceDate = new Date(FY_START);
  const targetSet = new Set(targetProductIds);

  while (Date.now() < deadline) {
    let url = `${apiDomain}/crm/v8/${moduleName}?fields=Product_Name,Net_Total,Created_Time,Parent_Id&per_page=200&sort_by=Created_Time&sort_order=desc`;
    url += tab.pageToken ? `&page_token=${tab.pageToken}` : `&page=${tab.page}`;
    const res = await fetch(url, { headers: authHeader });
    if (res.status === 204) break;
    if (!res.ok) throw new Error(`${moduleName} fetch failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const pageRecords = data.data || [];
    if (!pageRecords.length) break;

    let hitCutoff = false;
    pageRecords.forEach(item => {
      if (item.Created_Time && new Date(item.Created_Time) < sinceDate) { hitCutoff = true; return; }
      tab[scannedField]++;
      const productId = item.Product_Name?.id;
      const parentId = item.Parent_Id?.id;
      if (!productId || !targetSet.has(productId)) return;
      const ym = getISTYearMonth(item.Created_Time);
      if (!ym) return;
      const monthLabel = MONTH_NAMES[ym.month];
      const value = (item.Net_Total || 0) / 100000;
      tab[monthlyField][monthLabel] = (tab[monthlyField][monthLabel] || 0) + value;
      if (!tab[detailsField][monthLabel]) tab[detailsField][monthLabel] = [];
      tab[detailsField][monthLabel].push({ parentId, value: Math.round(value*100)/100, date: item.Created_Time, product: item.Product_Name?.name || null });
      tab[matchedField]++;
    });

    if (hitCutoff || !data.info?.more_records) { tab.page = 1; tab.pageToken = null; return true; }
    tab.pageToken = data.info?.next_page_token || null;
    tab.page++;
  }
  return false;
}

async function stepAccountNames(tab, accessToken, apiDomain, deadline) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  if (!tab.accountNamesPending) {
    const allParentIds = new Set();
    Object.values(tab.obDetails).forEach(arr => arr.forEach(d => d.parentId && allParentIds.add(d.parentId)));
    Object.values(tab.invDetails).forEach(arr => arr.forEach(d => d.parentId && allParentIds.add(d.parentId)));
    tab.accountNamesPending = [...allParentIds];
    tab.accountNamesPage = 0;
  }
  const CHUNK = 100;
  while (tab.accountNamesPage * CHUNK < tab.accountNamesPending.length) {
    if (Date.now() > deadline) return false;
    const chunk = tab.accountNamesPending.slice(tab.accountNamesPage * CHUNK, (tab.accountNamesPage + 1) * CHUNK);
    if (chunk.length) {
      for (const mod of ['Sales_Orders', 'Invoices']) {
        const stillNeeded = chunk.filter(id => !tab.accountNames[id]);
        if (!stillNeeded.length) break;
        const url = `${apiDomain}/crm/v8/${mod}?ids=${stillNeeded.join(',')}&fields=Account_Name,Deal_Name,Subject`;
        const res = await fetch(url, { headers: authHeader });
        if (res.ok) {
          const data = await res.json();
          (data.data || []).forEach(r => { tab.accountNames[r.id] = r.Account_Name?.name || r.Deal_Name || r.Subject || '—'; });
        }
      }
    }
    tab.accountNamesPage++;
  }
  return true;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const startTime = Date.now();
  const deadline = startTime + TIME_BUDGET_MS;

  try {
    const forceRestart = req.query?.restart === '1';
    let state = forceRestart ? null : await getCursor();
    // If resuming a cursor saved by an older version of this file (e.g.
    // before obDetails/accountNames tracking was added), merge in fresh
    // defaults for any missing fields (at the correct nesting level - the
    // fields that matter live inside state.tab) rather than crashing.
    state = state
      ? { tabIndex: state.tabIndex ?? 0, tab: { ...freshTabState(), ...(state.tab || {}) } }
      : freshState();

    const accessToken = await zohoAuth.getZohoAccessToken();
    const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';

    const completedTabs = [];
    const skippedTabs = [];

    while (state.tabIndex < PRODUCT_CONFIGS.length) {
      if (Date.now() > deadline) {
        await saveCursor(state);
        return res.status(200).json({
          complete: false, tabIndex: state.tabIndex, tab: PRODUCT_CONFIGS[state.tabIndex].key,
          completedTabs, skippedTabs, message: 'Time budget used, run again to continue.'
        });
      }

      const config = PRODUCT_CONFIGS[state.tabIndex];
      const tab = state.tab;

      const isFreshTabStart = !forceRestart && tab.stage === 'products' && tab.targetProductIds === null
        && tab.page === 1 && tab.basketIndex === 0;
      if (isFreshTabStart) {
        const existingRow = await getProductRow(config.key);
        if (isTodayIST(existingRow?.updated_at)) {
          skippedTabs.push(config.key);
          state.tabIndex++;
          state.tab = freshTabState();
          continue;
        }
      }

      if (tab.stage === 'products') {
        const done = await stepProducts(tab, config.baskets, accessToken, apiDomain, deadline);
        if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: 'products', tab: config.key, completedTabs, skippedTabs, message: 'Fetching target products, run again to continue.' }); }
        tab.stage = 'obItems';
      }

      if (tab.stage === 'obItems') {
        const done = await stepAggregateItems(tab, 'Ordered_Items', 'obMonthly', 'obDetails', 'obMatched', 'obScanned', tab.targetProductIds, accessToken, apiDomain, deadline);
        if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: 'obItems', tab: config.key, scannedSoFar: tab.obScanned, matchedSoFar: tab.obMatched, completedTabs, skippedTabs, message: 'Aggregating Order Booking line items, run again to continue.' }); }
        tab.stage = 'invItems';
      }

      if (tab.stage === 'invItems') {
        const done = await stepAggregateItems(tab, 'Invoiced_Items', 'invMonthly', 'invDetails', 'invMatched', 'invScanned', tab.targetProductIds, accessToken, apiDomain, deadline);
        if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: 'invItems', tab: config.key, scannedSoFar: tab.invScanned, matchedSoFar: tab.invMatched, completedTabs, skippedTabs, message: 'Aggregating Invoicing line items, run again to continue.' }); }
        tab.stage = 'accountNames';
      }

      if (tab.stage === 'accountNames') {
        const done = await stepAccountNames(tab, accessToken, apiDomain, deadline);
        if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: 'accountNames', tab: config.key, completedTabs, skippedTabs, message: 'Fetching account names, run again to continue.' }); }
        tab.stage = 'done';
      }

      const roundedOB = round1(tab.obMonthly);
      const roundedInv = round1(tab.invMonthly);
      const obDetailsFinal = attachAccountNames(tab.obDetails, tab.accountNames);
      const invDetailsFinal = attachAccountNames(tab.invDetails, tab.accountNames);
      const writtenAt = await writeTabResult(config.key, roundedOB, roundedInv, obDetailsFinal, invDetailsFinal);

      completedTabs.push({
        key: config.key,
        targetProductCount: tab.targetProductIds.length,
        obActuals: roundedOB, invActuals: roundedInv,
        obDiagnostics: { matchedLineItems: tab.obMatched, totalLineItemsScanned: tab.obScanned },
        invDiagnostics: { matchedLineItems: tab.invMatched, totalLineItemsScanned: tab.invScanned },
        writtenAt
      });

      state.tabIndex++;
      state.tab = freshTabState();
    }

    await clearCursor();
    res.status(200).json({ complete: true, completedTabs, skippedTabs });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
