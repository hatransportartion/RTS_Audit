import 'dotenv/config';

const AIRTABLE_API = 'https://api.airtable.com/v0';

export async function getRecords(baseId, tableId, viewId) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('AIRTABLE_TOKEN missing in .env');
  if (!baseId || !tableId) throw new Error('baseId and tableId are required');

  const records = [];
  let offset;

  do {
    const url = new URL(`${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableId)}`);
    if (viewId) url.searchParams.set('view', viewId);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable ${res.status} ${res.statusText}: ${body}`);
    }

    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);

  return records;
}

export async function getRecordsByField(baseId, tableId, fieldName, values) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('AIRTABLE_TOKEN missing in .env');
  if (!baseId || !tableId || !fieldName) {
    throw new Error('baseId, tableId, and fieldName are required');
  }
  if (!values?.length) return [];

  const escape = (v) => String(v).replace(/'/g, "''");
  const records = [];
  const BATCH = 20;

  for (let i = 0; i < values.length; i += BATCH) {
    const batch = values.slice(i, i + BATCH);
    // Force string comparison so this works for both text and number Airtable fields
    const formula = `OR(${batch
      .map((v) => `{${fieldName}}&''='${escape(v)}'`)
      .join(',')})`;

    let offset;
    do {
      const url = new URL(`${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableId)}`);
      url.searchParams.set('filterByFormula', formula);
      url.searchParams.set('pageSize', '100');
      if (offset) url.searchParams.set('offset', offset);

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text();
        if (body.includes('INVALID_FILTER_BY_FORMULA') && body.toLowerCase().includes('unknown field')) {
          console.warn(`[airtable] Field "${fieldName}" not found in table — returning [] for this lookup.`);
          return [];
        }
        throw new Error(`Airtable ${res.status} ${res.statusText}: ${body}`);
      }
      const data = await res.json();
      records.push(...data.records);
      offset = data.offset;
    } while (offset);
  }

  return records;
}

export async function createRecords(baseId, tableId, creates) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('AIRTABLE_TOKEN missing in .env');
  if (!baseId || !tableId) throw new Error('baseId and tableId are required');
  if (!creates.length) return [];

  const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableId)}`;
  const created = [];

  for (let i = 0; i < creates.length; i += 10) {
    const batch = creates.slice(i, i + 10);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: batch, typecast: true }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable create ${res.status} ${res.statusText}: ${body}`);
    }

    const data = await res.json();
    created.push(...data.records);
  }

  return created;
}

export async function updateRecords(baseId, tableId, updates) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('AIRTABLE_TOKEN missing in .env');
  if (!baseId || !tableId) throw new Error('baseId and tableId are required');
  if (!updates.length) return [];

  const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableId)}`;
  const updated = [];

  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: batch, typecast: true }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable update ${res.status} ${res.statusText}: ${body}`);
    }

    const data = await res.json();
    updated.push(...data.records);
  }

  return updated;
}
