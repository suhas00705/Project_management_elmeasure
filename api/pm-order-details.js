// Serves the click-to-drill-down popup data for PM Review's OB/Invoicing
// figures. This used to run a live Zoho query on every click (slow, and
// capped at 500 results to stay responsive). Now it just reads the
// pre-computed obDetails/invDetails that sync-pm-prepaid.js and
// sync-pm-baskets.js already calculated and stored overnight - fast, and
// returns the complete list with no artificial cap.
const SUPABASE_URL = 'https://xfdfbrfudsaxqgpsdboa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmZGZicmZ1ZHNheHFncHNkYm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTA1MzgsImV4cCI6MjA5NzM2NjUzOH0.sfUC5Mn_d7-FGkvQHyD01kdGM81TjG4VWzXoFv43n94';
const DASHBOARD_TABLE_URL = `${SUPABASE_URL}/rest/v1/PM_Desk`;

const VALID_TABS = ['pm', 'lvs', 'panel', 'ates', 'accl', 'fdp'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const tab = req.query?.tab;
    const type = req.query?.type; // 'ob' or 'inv'
    const month = req.query?.month; // optional, e.g. 'Apr'

    if (!tab || !VALID_TABS.includes(tab)) return res.status(400).json({ error: 'Invalid or missing tab parameter.' });
    if (type !== 'ob' && type !== 'inv') return res.status(400).json({ error: "type must be 'ob' or 'inv'." });

    const getRes = await fetch(`${DASHBOARD_TABLE_URL}?id=eq.${tab}&select=payload`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!getRes.ok) throw new Error(`Supabase read failed: ${getRes.status}`);
    const rows = await getRes.json();
    const payload = rows[0]?.payload || {};

    const detailsByMonth = (type === 'ob' ? payload.obDetails : payload.invDetails) || {};
    const actualsByMonth = (type === 'ob' ? payload.obActuals : payload.invActuals) || {};

    let orders, total;
    if (month) {
      orders = detailsByMonth[month] || [];
      total = actualsByMonth[month] ?? orders.reduce((s, o) => s + (o.value || 0), 0);
    } else {
      orders = Object.values(detailsByMonth).flat().sort((a, b) => new Date(b.date) - new Date(a.date));
      total = Object.values(actualsByMonth).reduce((s, v) => s + (v || 0), 0);
      total = Math.round(total * 10) / 10;
    }

    res.status(200).json({
      tab, type, month: month || 'FY-to-date',
      total,
      count: orders.length,
      truncated: false, // no cap - this is a fast Supabase read, not a live scan
      orders,
      lastSynced: payload.updatedAt || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
