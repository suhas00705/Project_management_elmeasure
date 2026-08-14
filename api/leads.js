const supabaseLeads = require('../lib/supabaseLeads');

// Reads pre-synced FY2025-26 + FY2026-27 leads from Supabase, plus the
// current Sales Engineer name list (also auto-synced daily from Zoho, so
// the Engineer filter never needs a manual code update again).
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const [leads, engineers] = await Promise.all([
      supabaseLeads.getCachedLeads(),
      supabaseLeads.getCachedEngineers()
    ]);
    res.status(200).json({ leads, count: leads.length, engineers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
