const zohoAuth = require('../lib/zohoAuth');

const SUPABASE_URL = 'https://xfdfbrfudsaxqgpsdboa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmZGZicmZ1ZHNheHFncHNkYm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTA1MzgsImV4cCI6MjA5NzM2NjUzOH0.sfUC5Mn_d7-FGkvQHyD01kdGM81TjG4VWzXoFv43n94';
const POTENTIALS_CACHE_URL = `${SUPABASE_URL}/rest/v1/potentials_cache`;
// Cursor state lives in PM_Desk (a separate table, never read by the main
// Potentials pipeline) - NOT in potentials_cache, to avoid any risk of a
// fake tracking row leaking into real Potentials data shown to users.
const PM_DESK_TABLE_URL = `${SUPABASE_URL}/rest/v1/PM_Desk`;
const CURSOR_ROW_ID = 'potentials-qty-sync-cursor';

// Same FY window as the main Potentials sync, for consistency.
const FY_START = '2025-04-01T00:00:00+05:30';
const TIME_BUDGET_MS = 52000;

async function getCursor() {
  const res = await fetch(`${PM_DESK_TABLE_URL}?id=eq.${CURSOR_ROW_ID}&select=payload`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.payload || null;
}

async function saveCursor(state) {
  const res = await fetch(PM_DESK_TABLE_URL, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({ id: CURSOR_ROW_ID, payload: state, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error(`Cursor save failed: ${res.status}`);
}

async function clearCursor() {
  await fetch(`${PM_DESK_TABLE_URL}?id=eq.${CURSOR_ROW_ID}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
}

// Targeted column-only update: only 'qty' is sent, so PostgREST's upsert
// leaves every other column (amount, probability, region, etc.) untouched.
async function writeQtyBatch(qtyMap) {
  const rows = Object.entries(qtyMap).map(([id, qty]) => ({ id, qty }));
  if (!rows.length) return;
  const res = await fetch(`${POTENTIALS_CACHE_URL}?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`Qty batch write failed: ${res.status} ${await res.text()}`);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const deadline = Date.now() + TIME_BUDGET_MS;
  try {
    const forceRestart = req.query?.restart === '1';
    let state = forceRestart ? null : await getCursor();
    if (!state) state = { page: 1, pageToken: null, qtyByParent: {}, scanned: 0, matched: 0 };

    const accessToken = await zohoAuth.getZohoAccessToken();
    const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
    const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };
    const sinceDate = new Date(FY_START);

    let more = true;
    while (more && Date.now() < deadline) {
      let url = `${apiDomain}/crm/v8/Products_Information1?fields=Quantity,Parent_Id,Created_Time&per_page=200&sort_by=Created_Time&sort_order=desc`;
      url += state.pageToken ? `&page_token=${state.pageToken}` : `&page=${state.page}`;
      const fetchRes = await fetch(url, { headers: authHeader });
      if (fetchRes.status === 204) break;
      if (!fetchRes.ok) throw new Error(`Products_Information1 fetch failed: ${fetchRes.status} ${await fetchRes.text()}`);
      const data = await fetchRes.json();
      const records = data.data || [];
      if (!records.length) break;

      let hitCutoff = false;
      records.forEach(item => {
        const created = item.Created_Time ? new Date(item.Created_Time) : null;
        if (created && created < sinceDate) { hitCutoff = true; return; }
        state.scanned++;
        const parentId = item.Parent_Id?.id;
        if (!parentId) return;
        state.qtyByParent[parentId] = (state.qtyByParent[parentId] || 0) + (item.Quantity || 0);
        state.matched++;
      });

      if (hitCutoff || !data.info?.more_records) { more = false; break; }
      state.pageToken = data.info?.next_page_token || null;
      state.page++;
    }

    if (more && Date.now() >= deadline) {
      await saveCursor(state);
      return res.status(200).json({
        complete: false, scannedSoFar: state.scanned, matchedSoFar: state.matched,
        message: 'Aggregating quantities, run again to continue.'
      });
    }

    // Finished scanning - write all aggregated quantities in batches
    const entries = Object.entries(state.qtyByParent);
    const BATCH = 300;
    for (let i = 0; i < entries.length; i += BATCH) {
      const batchMap = Object.fromEntries(entries.slice(i, i + BATCH));
      await writeQtyBatch(batchMap);
    }

    await clearCursor();
    res.status(200).json({
      complete: true,
      totalLineItemsScanned: state.scanned,
      matchedLineItems: state.matched,
      uniquePotentialsUpdated: entries.length,
      syncedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
