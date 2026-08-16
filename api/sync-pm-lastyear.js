const zohoAuth = require('../lib/zohoAuth');

const SUPABASE_URL = 'https://xfdfbrfudsaxqgpsdboa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmZGZicmZ1ZHNheHFncHNkYm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTA1MzgsImV4cCI6MjA5NzM2NjUzOH0.sfUC5Mn_d7-FGkvQHyD01kdGM81TjG4VWzXoFv43n94';
const PM_DESK_TABLE_URL = `${SUPABASE_URL}/rest/v1/PM_Desk`;
const CURSOR_ROW_ID = 'pm-lastyear-sync-cursor';

const FY_START = '2025-04-01T00:00:00+05:30';
const FY_END = '2026-04-01T00:00:00+05:30';
const NAGENDRAN_OWNER_ID = '1870461000070455183';
const MONTH_NAMES = ['', 'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const TIME_BUDGET_MS = 52000; // stop well before Vercel's 60s hard limit, save progress, let the next call resume

const TAB_BASKETS = {
  pm:    ['Prepaid', 'Smart Meters'],
  lvs:   ['SWITCHGEAR'],
  panel: ['Panel Meters', 'Panel Meters Gen-3.0'],
  ates:  ['Transfer Switch', 'Switch Transfer', 'Ates', 'ATeS Motorised'],
  accl:  ['ACCL', 'ACCL-1Ph', 'ACCL-3Ph'],
  fdp:   ['FDP']
};

function getISTYearMonth(isoString) {
  const match = (isoString || '').match(/^(\d{4})-(\d{2})-\d{2}/);
  if (!match) return null;
  return { year: parseInt(match[1], 10), month: parseInt(match[2], 10) };
}

async function getCursor() {
  const res = await fetch(`${PM_DESK_TABLE_URL}?id=eq.${CURSOR_ROW_ID}&select=payload`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase cursor read failed: ${res.status}`);
  const rows = await res.json();
  return rows[0]?.payload || null;
}

async function saveCursor(state) {
  const res = await fetch(PM_DESK_TABLE_URL, {
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
  await fetch(`${PM_DESK_TABLE_URL}?id=eq.${CURSOR_ROW_ID}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
}

async function getProductRow(productKey) {
  const res = await fetch(`${PM_DESK_TABLE_URL}?id=eq.${productKey}&select=payload`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase read failed for ${productKey}: ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

function isThisWeekIST(isoTimestamp) {
  if (!isoTimestamp) return false;
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const now = new Date(Date.now() + istOffsetMs);
  const stamp = new Date(new Date(isoTimestamp).getTime() + istOffsetMs);
  const daysDiff = (now - stamp) / (1000 * 60 * 60 * 24);
  return daysDiff < 7;
}

function round1(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Math.round(v * 10) / 10]));
}

async function writeTabResult(productKey, lastYearOB, lastYearInv) {
  const existingRow = await getProductRow(productKey);
  const existingPayload = existingRow?.payload || {};
  const updatedAt = new Date().toISOString();
  const newPayload = { ...existingPayload, lastYearOB, lastYearInv, lastYearSyncedAt: updatedAt };

  const res = await fetch(PM_DESK_TABLE_URL, {
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
    excludedOrderIds: null,
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
    if (data.info?.more_records) { tab.page++; } else { tab.basketIndex++; tab.page = 1; }
  }
  tab.targetProductIds = [...ids];
  return true;
}

async function stepExcludedOrders(tab, accessToken, apiDomain, deadline) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const ids = new Set(tab.excludedOrderIds || []);
  const sinceDate = new Date(FY_START);
  while (Date.now() < deadline) {
    let url = `${apiDomain}/crm/v8/Sales_Orders?fields=id,Owner,Created_Time&per_page=200&sort_by=Created_Time&sort_order=desc`;
    url += tab.pageToken ? `&page_token=${tab.pageToken}` : `&page=${tab.page}`;
    const res = await fetch(url, { headers: authHeader });
    if (res.status === 204) break;
    if (!res.ok) throw new Error(`Sales_Orders fetch failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const records = data.data || [];
    if (!records.length) break;
    let hitCutoff = false;
    records.forEach(r => {
      const created = r.Created_Time ? new Date(r.Created_Time) : null;
      if (created && created < sinceDate) { hitCutoff = true; return; }
      if (created && created >= new Date(FY_END)) return;
      if (r.Owner && r.Owner.id === NAGENDRAN_OWNER_ID) ids.add(r.id);
    });
    tab.excludedOrderIds = [...ids];
    if (hitCutoff || !data.info?.more_records) { tab.page = 1; tab.pageToken = null; return true; }
    tab.pageToken = data.info?.next_page_token || null;
    tab.page++;
  }
  tab.excludedOrderIds = [...ids];
  return false;
}

async function stepAggregateItems(tab, moduleName, monthlyField, matchedField, scannedField, targetProductIds, excludedParentIds, accessToken, apiDomain, deadline) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const sinceDate = new Date(FY_START);
  const untilDate = new Date(FY_END);
  const targetSet = new Set(targetProductIds);
  const excludedSet = new Set(excludedParentIds);

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
      const created = item.Created_Time ? new Date(item.Created_Time) : null;
      if (created && created < sinceDate) { hitCutoff = true; return; }
      if (created && created >= untilDate) return;
      tab[scannedField]++;
      const productId = item.Product_Name?.id;
      const parentId = item.Parent_Id?.id;
      if (!productId || !targetSet.has(productId)) return;
      if (parentId && excludedSet.has(parentId)) return;
      const ym = getISTYearMonth(item.Created_Time);
      if (!ym) return;
      const monthLabel = MONTH_NAMES[ym.month];
      tab[monthlyField][monthLabel] = (tab[monthlyField][monthLabel] || 0) + (item.Net_Total || 0) / 100000;
      tab[matchedField]++;
    });

    if (hitCutoff || !data.info?.more_records) { tab.page = 1; tab.pageToken = null; return true; }
    tab.pageToken = data.info?.next_page_token || null;
    tab.page++;
  }
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const deadline = Date.now() + TIME_BUDGET_MS;

  try {
    const forceRestart = req.query?.restart === '1';
    let state = forceRestart ? null : await getCursor();

    if (!state && !forceRestart) {
      const tabKeys = Object.keys(TAB_BASKETS);
      const getRes = await fetch(`${PM_DESK_TABLE_URL}?id=in.(${tabKeys.join(',')})&select=id,payload`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
      });
      if (getRes.ok) {
        const rows = await getRes.json();
        const allDoneThisWeek = tabKeys.every(tab => {
          const row = rows.find(r => r.id === tab);
          return isThisWeekIST(row?.payload?.lastYearSyncedAt);
        });
        if (allDoneThisWeek) {
          return res.status(200).json({ complete: true, skipped: true, message: 'FY2025-26 data already synced within the last 7 days - skipping (historical data changes rarely).' });
        }
      }
    }

    if (!state) state = freshState();

    const accessToken = await zohoAuth.getZohoAccessToken();
    const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';

    const completedTabs = [];

    while (state.tabIndex < Object.keys(TAB_BASKETS).length) {
      if (Date.now() > deadline) {
        await saveCursor(state);
        return res.status(200).json({
          complete: false, tabIndex: state.tabIndex, tab: Object.keys(TAB_BASKETS)[state.tabIndex],
          completedTabs, message: 'Time budget used, run again to continue.'
        });
      }

      const tabKey = Object.keys(TAB_BASKETS)[state.tabIndex];
      const baskets = TAB_BASKETS[tabKey];
      const tab = state.tab;
      const needsNagendranExclusion = tabKey === 'pm';

      if (tab.stage === 'products') {
        const done = await stepProducts(tab, baskets, accessToken, apiDomain, deadline);
        if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: 'products', tab: tabKey, completedTabs, message: 'Fetching target products, run again to continue.' }); }
        tab.stage = needsNagendranExclusion ? 'excludedOrders' : 'obItems';
      }

      if (tab.stage === 'excludedOrders') {
        const done = await stepExcludedOrders(tab, accessToken, apiDomain, deadline);
        if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: 'excludedOrders', tab: tabKey, completedTabs, message: 'Scanning Sales Orders for Nagendran exclusions, run again to continue.' }); }
        tab.stage = 'obItems';
      }

      if (tab.stage === 'obItems') {
        const done = await stepAggregateItems(tab, 'Ordered_Items', 'obMonthly', 'obMatched', 'obScanned', tab.targetProductIds, tab.excludedOrderIds || [], accessToken, apiDomain, deadline);
        if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: 'obItems', tab: tabKey, scannedSoFar: tab.obScanned, matchedSoFar: tab.obMatched, completedTabs, message: 'Aggregating FY2025-26 Order Booking, run again to continue.' }); }
        tab.stage = 'invItems';
      }

      if (tab.stage === 'invItems') {
        const done = await stepAggregateItems(tab, 'Invoiced_Items', 'invMonthly', 'invMatched', 'invScanned', tab.targetProductIds, tab.excludedOrderIds || [], accessToken, apiDomain, deadline);
        if (!done) { await saveCursor(state); return res.status(200).json({ complete: false, stage: 'invItems', tab: tabKey, scannedSoFar: tab.invScanned, matchedSoFar: tab.invMatched, completedTabs, message: 'Aggregating FY2025-26 Invoicing, run again to continue.' }); }
        tab.stage = 'done';
      }

      const roundedOB = round1(tab.obMonthly);
      const roundedInv = round1(tab.invMonthly);
      const writtenAt = await writeTabResult(tabKey, roundedOB, roundedInv);

      completedTabs.push({
        key: tabKey,
        targetProductCount: tab.targetProductIds.length,
        lastYearOB: roundedOB, lastYearInv: roundedInv,
        obDiagnostics: { matchedLineItems: tab.obMatched, totalLineItemsScanned: tab.obScanned },
        invDiagnostics: { matchedLineItems: tab.invMatched, totalLineItemsScanned: tab.invScanned },
        writtenAt
      });

      state.tabIndex++;
      state.tab = freshTabState();
    }

    await clearCursor();
    res.status(200).json({ complete: true, completedTabs });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
