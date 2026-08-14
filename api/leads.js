const zohoAuth = require('../lib/zohoAuth');

const LEADS_FIELDS = [
  'Full_Name', 'Company', 'Account_Name', 'Owner', 'Lead_Status',
  'Order_Value', 'Product_Solution_Type_Multi_Select',
  'Region', 'Created_Time'
].join(',');

// Simple warm-instance cache: persists only while this serverless function
// container stays warm (not guaranteed across cold starts or multiple
// regions), but avoids repeating the full ~257-call sequential fetch on
// every dashboard refresh within the cache window.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cache = { data: null, fetchedAt: 0 };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const now = Date.now();
    const forceRefresh = req.query?.refresh === '1';
    if (!forceRefresh && cache.data && (now - cache.fetchedAt) < CACHE_TTL_MS) {
      return res.status(200).json({ leads: cache.data, count: cache.data.length, cached: true });
    }

    const leads = await zohoAuth.fetchAllRecords('Leads', LEADS_FIELDS);
    cache = { data: leads, fetchedAt: now };
    res.status(200).json({ leads, count: leads.length, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
