const supabaseLeads = require('../lib/supabaseLeads');

// Reads pre-synced FY2025-26 + FY2026-27 leads from Supabase. This is fast
// and reliable because the slow part (pulling from Zoho, which can take
// 20-100+ seconds for thousands of records) happens separately in
// /api/sync-leads, on a schedule, not on every dashboard page load.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const leads = await supabaseLeads.getCachedLeads();
    res.status(200).json({ leads, count: leads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
