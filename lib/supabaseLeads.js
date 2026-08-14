// Reuses the same Supabase project already used by the Friday Review tab.
const SUPABASE_URL = 'https://xfdfbrfudsaxqgpsdboa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmZGZicmZ1ZHNheHFncHNkYm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTA1MzgsImV4cCI6MjA5NzM2NjUzOH0.sfUC5Mn_d7-FGkvQHyD01kdGM81TjG4VWzXoFv43n94';
const LEADS_CACHE_URL = `${SUPABASE_URL}/rest/v1/leads_cache`;

const headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json'
};

function toRow(zohoLead) {
  return {
    id: zohoLead.id,
    full_name: zohoLead.Full_Name || null,
    company: zohoLead.Company || null,
    account_name: zohoLead.Account_Name?.name || zohoLead.AccountName || null,
    owner_name: zohoLead.Owner?.name || zohoLead.OwnerName || null,
    lead_status: zohoLead.Lead_Status || null,
    order_value: zohoLead.Order_Value ?? null,
    region: zohoLead.Region || null,
    product_solution_type: zohoLead.Product_Solution_Type_Multi_Select || [],
    created_time: zohoLead.Created_Time || null
  };
}

// Upserts leads into Supabase in batches (Supabase/PostgREST handles large
// arrays fine, but we chunk to keep individual request payloads reasonable).
async function upsertLeads(zohoLeads) {
  const rows = zohoLeads.map(toRow);
  const BATCH_SIZE = 500;
  let written = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const res = await fetch(`${LEADS_CACHE_URL}?on_conflict=id`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch)
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Supabase upsert failed (batch ${i}): ${res.status} ${errText}`);
    }
    written += batch.length;
  }
  return written;
}

// Reads all cached leads back out, mapped to the same shape the frontend expects.
// IMPORTANT: this must NOT assume each request returns a fixed number of rows —
// Supabase/PostgREST can enforce its own per-request row cap (which may be
// smaller than what you ask for via Range), and assuming a fixed page size
// caused an earlier bug where the loop stopped after the first request,
// silently truncating the data to just the most recent leads. Instead, this
// reads the authoritative Content-Range response header (format "start-end/total")
// on every request and keeps paging until it has collected `total` rows.
async function getCachedLeads() {
  const REQUEST_SIZE = 1000; // how many rows we ASK for per request, not a guarantee
  let allRows = [];
  let from = 0;
  let total = null;

  while (true) {
    const to = from + REQUEST_SIZE - 1;
    const res = await fetch(`${LEADS_CACHE_URL}?select=*&order=created_time.desc,id.desc`, {
      headers: { ...headers, Range: `${from}-${to}` }
    });
    if (!res.ok && res.status !== 206) {
      const errText = await res.text();
      throw new Error(`Supabase read failed: ${res.status} ${errText}`);
    }
    const rows = await res.json();
    if (!rows.length) break; // nothing more to fetch

    allRows = allRows.concat(rows);

    const contentRange = res.headers.get('content-range'); // e.g. "0-999/10981" or "0-99/*"
    if (contentRange) {
      const [, totalStr] = contentRange.split('/');
      if (totalStr && totalStr !== '*') total = parseInt(totalStr, 10);
    }

    from += rows.length; // advance by what was ACTUALLY returned, not the requested size
    if (total !== null && from >= total) break; // collected everything
    if (total === null && rows.length < REQUEST_SIZE) break; // fallback if no Content-Range header at all
  }

  return allRows.map(r => ({
    id: r.id,
    Full_Name: r.full_name,
    Company: r.company,
    AccountName: r.account_name,
    OwnerName: r.owner_name,
    Lead_Status: r.lead_status,
    Order_Value: r.order_value,
    Region: r.region,
    Product_Solution_Type_Multi_Select: r.product_solution_type || [],
    Created_Time: r.created_time
  }));
}

module.exports = { upsertLeads, getCachedLeads };
