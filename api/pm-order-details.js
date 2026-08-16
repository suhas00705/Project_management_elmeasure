const zohoAuth = require('../lib/zohoAuth');

const NAGENDRAN_OWNER_ID = '1870461000070455183';
const FY_START = '2026-04-01T00:00:00+05:30';
const MONTH_TO_NUM = { Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12, Jan:1, Feb:2, Mar:3 };
const MAX_RESULTS = 500; // safety cap on how many individual line items we'll return/scan

// Same basket mapping as sync-pm-prepaid.js / sync-pm-baskets.js - kept in
// sync deliberately (small, stable list) rather than importing across files.
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

function monthDateRange(monthName) {
  if (!monthName || !MONTH_TO_NUM[monthName]) return null;
  const m = MONTH_TO_NUM[monthName];
  const fyStartYear = 2026; // FY2026-27
  const year = m >= 4 ? fyStartYear : fyStartYear + 1;
  const start = new Date(Date.UTC(year, m - 1, 1) - 5.5 * 60 * 60 * 1000);
  const end = new Date(Date.UTC(year, m, 1) - 5.5 * 60 * 60 * 1000);
  return { start, end };
}

async function fetchTargetProductIds(basketValues, accessToken, apiDomain) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const ids = new Set();
  for (const basket of basketValues) {
    let page = 1, more = true;
    while (more) {
      const criteria = encodeURIComponent(`(Product_Basket:equals:${basket})`);
      const url = `${apiDomain}/crm/v8/Products/search?criteria=${criteria}&fields=id&per_page=200&page=${page}`;
      const res = await fetch(url, { headers: authHeader });
      if (res.status === 204) break;
      if (!res.ok) break;
      const data = await res.json();
      (data.data || []).forEach(p => ids.add(p.id));
      more = data.info?.more_records || false;
      page++;
    }
  }
  return ids;
}

async function fetchExcludedParentIds(moduleName, accessToken, apiDomain, sinceDate) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const ids = new Set();
  let page = 1, pageToken = null, more = true;
  while (more) {
    let url = `${apiDomain}/crm/v8/${moduleName}?fields=id,Owner,Created_Time&per_page=200&sort_by=Created_Time&sort_order=desc`;
    url += pageToken ? `&page_token=${pageToken}` : `&page=${page}`;
    const res = await fetch(url, { headers: authHeader });
    if (res.status === 204) break;
    if (!res.ok) break;
    const data = await res.json();
    const records = data.data || [];
    if (!records.length) break;
    let hitCutoff = false;
    records.forEach(r => {
      if (r.Created_Time && new Date(r.Created_Time) < sinceDate) { hitCutoff = true; return; }
      if (r.Owner && r.Owner.id === NAGENDRAN_OWNER_ID) ids.add(r.id);
    });
    if (hitCutoff || !data.info?.more_records) break;
    pageToken = data.info?.next_page_token || null;
    page++;
    more = true;
  }
  return ids;
}

async function fetchAccountNames(parentIds, moduleName, accessToken, apiDomain) {
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const nameMap = {};
  const idList = [...parentIds];
  const CHUNK = 100;
  for (let i = 0; i < idList.length; i += CHUNK) {
    const chunk = idList.slice(i, i + CHUNK);
    const url = `${apiDomain}/crm/v8/${moduleName}?ids=${chunk.join(',')}&fields=Account_Name,Deal_Name,Subject`;
    const res = await fetch(url, { headers: authHeader });
    if (!res.ok) continue;
    const data = await res.json();
    (data.data || []).forEach(r => {
      nameMap[r.id] = r.Account_Name?.name || r.Deal_Name || r.Subject || '—';
    });
  }
  return nameMap;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const tab = req.query?.tab;
    const type = req.query?.type; // 'ob' or 'inv'
    const month = req.query?.month; // optional, e.g. 'Apr'

    if (!tab || !TAB_BASKETS[tab]) return res.status(400).json({ error: 'Invalid or missing tab parameter.' });
    if (type !== 'ob' && type !== 'inv') return res.status(400).json({ error: "type must be 'ob' or 'inv'." });

    const accessToken = await zohoAuth.getZohoAccessToken();
    const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';

    const range = monthDateRange(month);
    const sinceDate = range ? range.start : new Date(FY_START);
    const untilDate = range ? range.end : null;

    const itemsModule = type === 'ob' ? 'Ordered_Items' : 'Invoiced_Items';
    const parentModule = type === 'ob' ? 'Sales_Orders' : 'Invoices';

    const targetProductIds = await fetchTargetProductIds(TAB_BASKETS[tab], accessToken, apiDomain);
    const excludedParentIds = tab === 'pm'
      ? await fetchExcludedParentIds(parentModule, accessToken, apiDomain, sinceDate)
      : new Set();

    const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
    let page = 1, pageToken = null, more = true;
    const matched = [];
    let total = 0;
    let scanned = 0;

    while (more) {
      let url = `${apiDomain}/crm/v8/${itemsModule}?fields=Product_Name,Net_Total,Created_Time,Parent_Id&per_page=200&sort_by=Created_Time&sort_order=desc`;
      url += pageToken ? `&page_token=${pageToken}` : `&page=${page}`;
      const fetchRes = await fetch(url, { headers: authHeader });
      if (fetchRes.status === 204) break;
      if (!fetchRes.ok) throw new Error(`${itemsModule} fetch failed: ${fetchRes.status}`);
      const data = await fetchRes.json();
      const records = data.data || [];
      if (!records.length) break;

      let hitCutoff = false;
      for (const item of records) {
        const created = item.Created_Time ? new Date(item.Created_Time) : null;
        if (created && created < sinceDate) { hitCutoff = true; break; }
        if (untilDate && created && created >= untilDate) continue; // newer than this month's window, skip
        scanned++;
        const productId = item.Product_Name?.id;
        const parentId = item.Parent_Id?.id;
        if (!productId || !targetProductIds.has(productId)) continue;
        if (parentId && excludedParentIds.has(parentId)) continue;
        total += (item.Net_Total || 0) / 100000;
        if (matched.length < MAX_RESULTS) {
          matched.push({ parentId, value: (item.Net_Total || 0) / 100000, date: item.Created_Time, product: item.Product_Name?.name || null });
        }
      }

      if (hitCutoff || !data.info?.more_records) break;
      pageToken = data.info?.next_page_token || null;
      page++;
    }

    const uniqueParentIds = new Set(matched.map(m => m.parentId).filter(Boolean));
    const accountNames = await fetchAccountNames(uniqueParentIds, parentModule, accessToken, apiDomain);

    const orders = matched.map(m => ({
      account: accountNames[m.parentId] || '—',
      value: Math.round(m.value * 100) / 100,
      date: m.date,
      product: m.product,
      orderId: m.parentId
    })).sort((a, b) => new Date(b.date) - new Date(a.date));

    res.status(200).json({
      tab, type, month: month || 'FY-to-date',
      total: Math.round(total * 10) / 10,
      count: orders.length,
      scanned,
      truncated: matched.length >= MAX_RESULTS,
      orders
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
