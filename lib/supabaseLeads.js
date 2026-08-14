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
async function getCachedLeads() {
  const res = await fetch(`${LEADS_CACHE_URL}?select=*&order=created_time.desc&limit=20000`, { headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase read failed: ${res.status} ${errText}`);
  }
  const rows = await res.json();
  return rows.map(r => ({
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
