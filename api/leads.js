const { fetchAllRecords } = require('../lib/zohoAuth');

const LEADS_FIELDS = [
  'Full_Name', 'Company', 'Account_Name', 'Owner', 'Lead_Status',
  'Order_Value', 'Product_Solution_Type_Multi_Select',
  'Region', 'Created_Time'
].join(',');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const leads = await fetchAllRecords('Leads', LEADS_FIELDS);
    res.status(200).json({ leads, count: leads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
