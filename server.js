require('dotenv').config();
const express = require('express');
const path = require('path');
const { getZohoAccessToken } = require('./zohoAuth');

const app = express();
const PORT = process.env.PORT || 3000;
const ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';

// ---- Serve the dashboard (index.html + any static assets) ----
app.use(express.static(path.join(__dirname, 'public')));

// ---- Shared helper to page through a Zoho module ----
async function fetchAllRecords(module, fields) {
  const accessToken = await getZohoAccessToken();
  let records = [];
  let page = 1;
  let more = true;

  while (more && page <= 5) {
    const url = `${ZOHO_API_DOMAIN}/crm/v8/${module}?fields=${fields}&per_page=200&page=${page}&sort_by=Created_Time&sort_order=desc`;
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

// ---- /api/leads ----
const LEADS_FIELDS = [
  'Full_Name', 'Company', 'Account_Name', 'Owner', 'Lead_Status',
  'Order_Value', 'Product_Solution_Type_Multi_Select',
  'Region', 'Created_Time'
].join(',');

app.get('/api/leads', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const leads = await fetchAllRecords('Leads', LEADS_FIELDS);
    res.json({ leads, count: leads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- /api/potentials ----
// Zoho's REST module name for "Potentials" (as shown in the CRM UI) is "Deals".
const POTENTIALS_FIELDS = [
  'Deal_Name', 'Account_Name', 'Owner', 'Stage',
  'Amount', 'Product_Solution_Type_Multi_Select',
  'Region', 'Sub_Region', 'Probability',
  'Closing_Date', 'Created_Time'
].join(',');

app.get('/api/potentials', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const deals = await fetchAllRecords('Deals', POTENTIALS_FIELDS);
    res.json({ deals, count: deals.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Fallback: always serve the dashboard for any other route ----
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PulseBoard server running on port ${PORT}`);
});
