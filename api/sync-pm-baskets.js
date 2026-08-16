// Auto-syncs OB (Order Booking) & Invoicing actuals for the LVS, Panel Meters,
// ATES, ACCL and FDP tabs on the PM Review dashboard — same idea as
// sync-pm-prepaid.js (which does this for the Prepaid Meters tab), generalized
// to loop over several product baskets in one resumable run.
//
// Unlike Prepaid, these 5 tabs do NOT exclude any particular owner's Sales
// Orders/Invoices — every matching order/invoice line item counts, by design
// (confirmed with the business owner; Prepaid's "Nagendran" exclusion is
// specific to that product line and does not apply here).
//
// Matches Zoho CRM Products by their (free-text) Product_Basket field:
//   lvs   -> "SWITCHGEAR"
//   panel -> "Panel Meters", "Panel Meters Gen-3.0"
//   ates  -> "Transfer Switch", "Switch Transfer", "Ates", "ATeS Motorised"
//   accl  -> "ACCL", "ACCL-1Ph", "ACCL-3Ph"
//   fdp   -> "FDP"
//
// Each tab's OB/Invoicing line items (Ordered_Items / Invoiced_Items) are
// pulled since FY_START, summed by month (Net_Total, converted to Rs Lakhs),
// and written into Supabase's PM_Desk table under that tab's own row id
// (e.g. id='lvs'), merged with whatever else is already saved for that
// product (fyOB/fyInv targets, weekly pulse, activities, visibility items —
// none of that is touched, only obActuals/invActuals/updatedAt are replaced).
//
// Resumable: like sync-pm-prepaid.js, progress is checkpointed to Supabase
// (a separate cursor row from Prepaid's) so a run that hits Vercel's ~60s
// limit picks up exactly where it left off on the next scheduled invocation.
const zohoAuth = require('../lib/zohoAuth');

const SUPABASE_URL = 'https://xfdfbrfudsaxqgpsdboa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmZGZicmZ1ZHNheHFncHNkYm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTA1MzgsImV4cCI6MjA5NzM2NjUzOH0.sfUC5Mn_d7-FGkvQHyD01kdGM81TjG4VWzXoFv43n94';
const DASHBOARD_TABLE_URL = `${SUPABASE_URL}/rest/v1/PM_Desk`;
const CURSOR_ROW_ID = 'pm-baskets-sync-cursor';

const FY_START = '2026-04-01T00:00:00+05:30';
const MONTH_NAMES = ['', 'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const TIME_BUDGET_MS = 52000; // stop well before Vercel's 60s hard limit, save progress, let the next call resume

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

async function getProductRow(productKey) {
  const res = await fetch(`${DASHBOARD_TABLE_URL}?id=eq.${productKey}&select=payload,updated_at`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase read failed for ${productKey}: ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

// Compares IST calendar dates (UTC+5:30) so "today" matches the morning
// cron's local sense of day, not the server's UTC date.
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

async function writeTabResult(productKey, obActuals, invActuals) {
  const existingRow = await getProductRow(productKey);
  const existingPayload = existingRow?.payload || {};
  const updatedAt = new Date().toISOString();
  const newPayload = { ...existingPayload, obActuals, invActuals, updatedAt };

  const res = await fetch(DASHBOARD_TABLE_URL, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({ id: productKey, payload: newPayload, updated_at: updatedAt })
  });
  if (!res.ok) throw new Error(`Supabase write failed for ${productKey}: ${res.status} ${await res.text()}`);
  return updatedAt;
}

function freshTabState() {
  return {
    stage: 'products',
    targetProductIds: null,
    obMonthly: {}, obMatched: 0, obScanned: 0,
    invMonthly: {}, invMatched: 0, invScanned: 0,
    page: 1, pageToken: null,
    basketIndex: 0
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
    if (data.info?.more_records) {
      tab.page++;
    } else {
      tab.basketIndex++;
      tab.page = 1;
    }
  }
  tab.targetProductIds = [...ids];
  return true;
}

async function stepAggregateItems(tab, moduleName, monthlyField, matchedField, scannedField, targetProductIds, accessToken, apiDomain, deadline) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const sinceDate = new Date(FY_START);
  const targetSet = new Set(targetProductIds);

  while (Date.now() < deadline) {
    let url = `${apiDomain}/crm/v8/${moduleName}?fields=Product_Name,Net_Total,Created_Time&per_page=200&sort_by=Created_Time&sort_order=desc`;
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
      if (!productId || !targetSet.has(productId)) return;
      const ym = getISTYearMonth(item.Created_Time);
      if (!ym) return;
      const monthLabel = MONTH_NAMES[ym.month];
      tab[monthlyField][monthLabel] = (tab[monthlyField][monthLabel] || 0) + (item.Net_Total || 0) / 100000;
      tab[matchedField]++;
    });

    if (hitCutoff || !data.info?.more_records) {
      tab.page = 1; tab.pageToken = null;
      return true;
    }
    tab.pageToken = data.info?.next_page_token || null;
    tab.page++;
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
    if (!state) state = freshState();

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

      // Only skip a tab that already synced today if we're at the very start of
      // it (not resuming mid-tab from a saved cursor) — avoids wasteful/duplicate
      // re-runs from the multiple scheduled attempts each morning.
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
        if (!done) {
          await saveCursor(state);
          return res.status(200).json({ complete: false, stage: 'products', tab: config.key, completedTabs, skippedTabs, message: 'Fetching target products, run again to continue.' });
        }
        tab.stage = 'obItems';
      }

      if (tab.stage === 'obItems') {
        const done = await stepAggregateItems(tab, 'Ordered_Items', 'obMonthly', 'obMatched', 'obScanned', tab.targetProductIds, accessToken, apiDomain, deadline);
        if (!done) {
          await saveCursor(state);
          return res.status(200).json({ complete: false, stage: 'obItems', tab: config.key, scannedSoFar: tab.obScanned, matchedSoFar: tab.obMatched, completedTabs, skippedTabs, message: 'Aggregating Order Booking line items, run again to continue.' });
        }
        tab.stage = 'invItems';
      }

      if (tab.stage === 'invItems') {
        const done = await stepAggregateItems(tab, 'Invoiced_Items', 'invMonthly', 'invMatched', 'invScanned', tab.targetProductIds, accessToken, apiDomain, deadline);
        if (!done) {
          await saveCursor(state);
          return res.status(200).json({ complete: false, stage: 'invItems', tab: config.key, scannedSoFar: tab.invScanned, matchedSoFar: tab.invMatched, completedTabs, skippedTabs, message: 'Aggregating Invoicing line items, run again to continue.' });
        }
        tab.stage = 'done';
      }

      const roundedOB = round1(tab.obMonthly);
      const roundedInv = round1(tab.invMonthly);
      const writtenAt = await writeTabResult(config.key, roundedOB, roundedInv);

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
