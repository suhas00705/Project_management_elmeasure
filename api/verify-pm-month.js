// One-off diagnostic tool: independently computes the true OB or Invoicing
// total for a single PM Review basket + month, directly from Zoho, live -
// bounded to one month (not a full FY), so it should complete in a single
// call without needing the resumable multi-attempt pattern. Used to verify
// a figure the user is questioning against what's actually cached/shown.
// Not scheduled by any cron - triggered manually, on demand, when needed.
const zohoAuth = require('../lib/zohoAuth');

const NAGENDRAN_OWNER_ID = '1870461000070455183';
const MONTH_TO_NUM = { Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12, Jan:1, Feb:2, Mar:3 };

const TAB_BASKETS = {
  pm:    ['Prepaid', 'Smart Meters'],
  lvs:   ['SWITCHGEAR'],
  panel: ['Panel Meters', 'Panel Meters Gen-3.0'],
  ates:  ['Transfer Switch', 'Switch Transfer', 'Ates', 'ATeS Motorised'],
  accl:  ['ACCL', 'ACCL-1Ph', 'ACCL-3Ph'],
  fdp:   ['FDP']
};

function monthDateRange(monthName, fyStartYear) {
  const m = MONTH_TO_NUM[monthName];
  if (!m) return null;
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

async function fetchExcludedParentIds(moduleName, accessToken, apiDomain, start, end) {
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
      const created = r.Created_Time ? new Date(r.Created_Time) : null;
      if (created && created < start) { hitCutoff = true; return; }
      if (created && created >= end) return;
      if (r.Owner && r.Owner.id === NAGENDRAN_OWNER_ID) ids.add(r.id);
    });
    if (hitCutoff || !data.info?.more_records) break;
    pageToken = data.info?.next_page_token || null;
    page++;
  }
  return ids;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const tab = req.query?.tab;
    const type = req.query?.type;
    const month = req.query?.month;
    const fyStartYear = parseInt(req.query?.fy || '2026', 10);

    if (!tab || !TAB_BASKETS[tab]) return res.status(400).json({ error: 'Invalid tab.' });
    if (type !== 'ob' && type !== 'inv') return res.status(400).json({ error: "type must be 'ob' or 'inv'." });
    const range = monthDateRange(month, fyStartYear);
    if (!range) return res.status(400).json({ error: 'Invalid month.' });

    const accessToken = await zohoAuth.getZohoAccessToken();
    const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
    const itemsModule = type === 'ob' ? 'Ordered_Items' : 'Invoiced_Items';
    const parentModule = type === 'ob' ? 'Sales_Orders' : 'Invoices';

    const targetProductIds = await fetchTargetProductIds(TAB_BASKETS[tab], accessToken, apiDomain);
    const excludedParentIds = tab === 'pm'
      ? await fetchExcludedParentIds(parentModule, accessToken, apiDomain, range.start, range.end)
      : new Set();

    const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
    let page = 1, pageToken = null, more = true;
    let total = 0, matched = 0, scanned = 0;
    const sample = [];

    while (more) {
      let url = `${apiDomain}/crm/v8/${itemsModule}?fields=Product_Name,Net_Total,Created_Time,Parent_Id&per_page=200&sort_by=Created_Time&sort_order=desc`;
      url += pageToken ? `&page_token=${pageToken}` : `&page=${page}`;
      const fetchRes = await fetch(url, { headers: authHeader });
      if (fetchRes.status === 204) break;
      if (!fetchRes.ok) throw new Error(`${itemsModule} fetch failed: ${fetchRes.status} ${await fetchRes.text()}`);
      const data = await fetchRes.json();
      const records = data.data || [];
      if (!records.length) break;

      let hitCutoff = false;
      for (const item of records) {
        const created = item.Created_Time ? new Date(item.Created_Time) : null;
        if (created && created < range.start) { hitCutoff = true; break; }
        if (created && created >= range.end) continue;
        scanned++;
        const productId = item.Product_Name?.id;
        const parentId = item.Parent_Id?.id;
        if (!productId || !targetProductIds.has(productId)) continue;
        if (parentId && excludedParentIds.has(parentId)) continue;
        const value = (item.Net_Total || 0) / 100000;
        total += value;
        matched++;
        if (sample.length < 10) sample.push({ parentId, value: Math.round(value*100)/100, date: item.Created_Time, product: item.Product_Name?.name });
      }
      if (hitCutoff || !data.info?.more_records) break;
      pageToken = data.info?.next_page_token || null;
      page++;
    }

    res.status(200).json({
      tab, type, month, fyStartYear,
      targetProductCount: targetProductIds.size,
      excludedParentCount: excludedParentIds.size,
      totalScanned: scanned,
      matchedLineItems: matched,
      liveTotal: Math.round(total * 10) / 10,
      sampleOrders: sample
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
