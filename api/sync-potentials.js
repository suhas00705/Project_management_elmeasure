const zohoAuth = require('../lib/zohoAuth');
const supabasePotentials = require('../lib/supabasePotentials');

const POTENTIALS_FIELDS = [
  'Deal_Name', 'Account_Name', 'Owner', 'Region', 'Amount',
  'Product_Solution_Type_Multi_Select', 'Created_Time'
].join(',');

// Same FY window used for Leads, for consistency across the dashboard.
const FY_START = '2025-04-01T00:00:00+05:30';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const potentials = await zohoAuth.fetchRecordsSince('Potentials', POTENTIALS_FIELDS, FY_START);
    const written = await supabasePotentials.upsertPotentials(potentials);
    res.status(200).json({
      synced: written,
      fyStart: FY_START,
      syncedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
