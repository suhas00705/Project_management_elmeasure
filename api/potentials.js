const supabasePotentials = require('../lib/supabasePotentials');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const potentials = await supabasePotentials.getCachedPotentials();
    res.status(200).json({ potentials, count: potentials.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
