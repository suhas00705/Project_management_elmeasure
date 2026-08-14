const zohoAuth = require('../lib/zohoAuth');
const supabaseLeads = require('../lib/supabaseLeads');

const LEADS_FIELDS = [
  'Full_Name', 'Company', 'Account_Name', 'Owner', 'Lead_Status',
  'Order_Value', 'Product_Solution_Type_Multi_Select',
  'Region', 'Created_Time'
].join(',');

// FY2025-26 starts April 1, 2025 (IST). Leads created on/after this date cover
// both FY2025-26 and the current FY2026-27, which is what the dashboard shows.
const FY_START = '2025-04-01T00:00:00+05:30';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const leads = await zohoAuth.fetchRecordsSince('Leads', LEADS_FIELDS, FY_START);
    const leadsWritten = await supabaseLeads.upsertLeads(leads);

    const engineers = await zohoAuth.fetchSalesEngineers();
    const engineersWritten = await supabaseLeads.upsertEngineers(engineers);
    await supabaseLeads.pruneEngineers(engineers.map(e => e.id));

    res.status(200).json({
      synced: leadsWritten,
      engineersSynced: engineersWritten,
      fyStart: FY_START,
      syncedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
