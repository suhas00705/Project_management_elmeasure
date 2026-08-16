const zohoAuth = require('../lib/zohoAuth');
const supabasePotentials = require('../lib/supabasePotentials');

const POTENTIALS_FIELDS = [
  'Deal_Name', 'Account_Name', 'Owner', 'Region', 'Amount', 'Stage', 'Probability',
  'Product_Solution_Type_Multi_Select', 'Created_Time'
].join(',');

// FY2025-26 starts April 1, 2025 (IST). Leads created on/after this date cover
// both FY2025-26 and the current FY2026-27, which is what the dashboard shows.
const FY_START = '2025-04-01T00:00:00+05:30';

// Closed deals (won or lost) shouldn't appear on an active-pipeline dashboard.
// This org's Stage values look like "Closed Won(O)" / "Closed Lost(C)" — any
// stage starting with "Closed" (case-insensitive) is excluded from the sync.
function isClosedStage(stage){
  return (stage || '').trim().toLowerCase().startsWith('closed');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const allPotentials = await zohoAuth.fetchRecordsSince('Potentials', POTENTIALS_FIELDS, FY_START);
    const openPotentials = allPotentials.filter(p => !isClosedStage(p.Stage));
    const written = await supabasePotentials.upsertPotentials(openPotentials);
    res.status(200).json({
      synced: written,
      totalFetched: allPotentials.length,
      excludedClosed: allPotentials.length - openPotentials.length,
      fyStart: FY_START,
      syncedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
