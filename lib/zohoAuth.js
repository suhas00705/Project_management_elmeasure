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

// Pages through a Zoho CRM module and returns all matching records.
async function fetchAllRecords(moduleName, fields) {
  const ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
  const accessToken = await getZohoAccessToken();
  let records = [];
  let page = 1;
  let more = true;

  while (more && page <= 5) {
    const url = `${ZOHO_API_DOMAIN}/crm/v8/${moduleName}?fields=${fields}&per_page=200&page=${page}&sort_by=Created_Time&sort_order=desc`;
    const res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }
    });
    if (res.status === 204) break;
    const data = await res.json();
    if (data.data) records = records.concat(data.data);
    more = data.info?.more_records || false;
    page++;
  }
  return records;
}

module.exports = { getZohoAccessToken, fetchAllRecords };
