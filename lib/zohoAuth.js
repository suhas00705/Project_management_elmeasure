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
// IMPORTANT: Zoho's simple page=1,2,3... pagination only works up to 2000 records
// (10 pages of 200). Beyond that, Zoho requires switching to cursor-based pagination
// using the "page_token" returned in the previous response's info block. Token-based
// pages must be fetched one at a time in order (each token depends on the last), so
// this cannot be parallelized past record #2000.
async function fetchAllRecords(moduleName, fields) {
  const ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
  const accessToken = await getZohoAccessToken();
  const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };

  const PER_PAGE = 200;
  const MAX_RECORDS = 100000; // safety ceiling, well above current lead volume

  let records = [];
  let page = 1;
  let pageToken = null;
  let more = true;

  while (more && records.length < MAX_RECORDS) {
    let url = `${ZOHO_API_DOMAIN}/crm/v8/${moduleName}?fields=${fields}&per_page=${PER_PAGE}&sort_by=Created_Time&sort_order=desc`;
    url += pageToken ? `&page_token=${pageToken}` : `&page=${page}`;

    const res = await fetch(url, { headers: authHeader });
    if (res.status === 204) break;
    const data = await res.json();
    if (data.data) records = records.concat(data.data);

    more = data.info?.more_records || false;
    pageToken = data.info?.next_page_token || null;
    page++;
  }
  return records;
}

module.exports = { getZohoAccessToken, fetchAllRecords };
