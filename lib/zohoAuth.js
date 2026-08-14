// Shared helper: exchanges the long-lived Zoho refresh token for a short-lived
// access token. Access tokens expire ~1hr, so we fetch a fresh one per request.
//
// Reads credentials from Vercel Environment Variables (Project Settings -> Environment
// Variables). Required:
//   ZOHO_CLIENT_ID
//   ZOHO_CLIENT_SECRET
//   ZOHO_REFRESH_TOKEN
//   ZOHO_ACCOUNTS_DOMAIN   e.g. https://accounts.zoho.com  (use .in / .eu if applicable)

async function getZohoAccessToken() {
  const {
    ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN,
    ZOHO_ACCOUNTS_DOMAIN = 'https://accounts.zoho.com'
  } = process.env;

  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new Error('Missing Zoho OAuth environment variables on the server.');
  }

  const url = `${ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/token?refresh_token=${ZOHO_REFRESH_TOKEN}&client_id=${ZOHO_CLIENT_ID}&client_secret=${ZOHO_CLIENT_SECRET}&grant_type=refresh_token`;

  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();

  if (!data.access_token) {
    throw new Error('Zoho token refresh failed: ' + JSON.stringify(data));
  }
  return data.access_token;
}

// Pages through a Zoho CRM module and returns ALL matching records (no artificial cap).
// Strategy: get the true record count first, then fetch every page of 200 in
// parallel batches (rather than one page at a time) so large modules like Leads
// (tens of thousands of records) still return within a serverless function's time limit.
async function fetchAllRecords(moduleName, fields) {
  const ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
  const accessToken = await getZohoAccessToken();
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };

  // 1. Get the true total record count.
  const countRes = await fetch(`${ZOHO_API_DOMAIN}/crm/v8/${moduleName}/actions/count`, { headers: authHeader });
  const countData = await countRes.json();
  const totalCount = countData?.count ?? 0;
  if (!totalCount) return [];

  const PER_PAGE = 200;
  const totalPages = Math.min(Math.ceil(totalCount / PER_PAGE), 1000); // safety ceiling: 200k records
  const CONCURRENCY = 8; // parallel requests at a time, to respect Zoho's rate limits

  async function fetchPage(page) {
    const url = `${ZOHO_API_DOMAIN}/crm/v8/${moduleName}?fields=${fields}&per_page=${PER_PAGE}&page=${page}&sort_by=Created_Time&sort_order=desc`;
    const res = await fetch(url, { headers: authHeader });
    if (res.status === 204) return [];
    const data = await res.json();
    return data.data || [];
  }

  let records = [];
  const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);
  for (let i = 0; i < pageNumbers.length; i += CONCURRENCY) {
    const batch = pageNumbers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(fetchPage));
    results.forEach(pageRecords => { records = records.concat(pageRecords); });
  }
  return records;
}

module.exports = { getZohoAccessToken, fetchAllRecords };
