// Reuses the same Supabase project already used by Leads and Friday Review.
const SUPABASE_URL = 'https://xfdfbrfudsaxqgpsdboa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmZGZicmZ1ZHNheHFncHNkYm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTA1MzgsImV4cCI6MjA5NzM2NjUzOH0.sfUC5Mn_d7-FGkvQHyD01kdGM81TjG4VWzXoFv43n94';
const POTENTIALS_CACHE_URL = `${SUPABASE_URL}/rest/v1/potentials_cache`;

const headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json'
};

function toRow(zohoPotential) {
  return {
    id: zohoPotential.id,
    deal_name: zohoPotential.Deal_Name || null,
    account_name: zohoPotential.Account_Name?.name || null,
    owner_name: zohoPotential.Owner?.name || null,
    region: zohoPotential.Region || null,
    amount: zohoPotential.Amount ?? null,
    probability: zohoPotential.Probability ?? null,
    product_solution_type: zohoPotential.Product_Solution_Type_Multi_Select || [],
    created_time: zohoPotential.Created_Time || null
  };
}

// Upserts potentials into Supabase in batches, same pattern as leads.
async function upsertPotentials(zohoPotentials) {
  const rows = zohoPotentials.map(toRow);
  const BATCH_SIZE = 500;
  let written = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const res = await fetch(`${POTENTIALS_CACHE_URL}?on_conflict=id`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch)
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Supabase potentials upsert failed (batch ${i}): ${res.status} ${errText}`);
    }
    written += batch.length;
  }
  return written;
}

// Reads all cached potentials back out, using Content-Range pagination
// (not a fixed page-size assumption) — same fix applied to the leads reader.
async function getCachedPotentials() {
  const REQUEST_SIZE = 1000;
  let allRows = [];
  let from = 0;
  let total = null;

  while (true) {
    const to = from + REQUEST_SIZE - 1;
    const res = await fetch(`${POTENTIALS_CACHE_URL}?select=*&order=created_time.desc,id.desc`, {
      headers: { ...headers, Range: `${from}-${to}` }
    });
    if (!res.ok && res.status !== 206) {
      const errText = await res.text();
      throw new Error(`Supabase potentials read failed: ${res.status} ${errText}`);
    }
    const rows = await res.json();
    if (!rows.length) break;
    allRows = allRows.concat(rows);

    const contentRange = res.headers.get('content-range');
    if (contentRange) {
      const [, totalStr] = contentRange.split('/');
      if (totalStr && totalStr !== '*') total = parseInt(totalStr, 10);
    }
    from += rows.length;
    if (total !== null && from >= total) break;
    if (total === null && rows.length < REQUEST_SIZE) break;
  }

  return allRows.map(r => ({
    id: r.id,
    Deal_Name: r.deal_name,
    AccountName: r.account_name,
    OwnerName: r.owner_name,
    Region: r.region,
    Amount: r.amount,
    Probability: r.probability,
    Qty: r.qty,
    Product_Solution_Type_Multi_Select: r.product_solution_type || [],
    Created_Time: r.created_time
  }));
}

module.exports = { upsertPotentials, getCachedPotentials };
