// Loads a backup made by backup_snapshot() back into a database, replacing what is there.
// `run(sql, params)` runs one statement and returns { rows }; it works with a pg client or PGlite.
// Everything happens in one transaction, so a failed restore leaves the database as it was.

export function checkSnapshot(snapshot) {
  if (snapshot?.format !== 'rm-pos-backup' || snapshot.version !== 1 || !snapshot.tables || typeof snapshot.tables !== 'object') {
    throw new Error('This file is not an RM POS backup.');
  }
}

const quote = (name) => `"${name.replace(/"/g, '""')}"`;

export async function restoreSnapshot(run, snapshot) {
  checkSnapshot(snapshot);
  const { rows } = await run(`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`);
  const existing = new Set(rows.map((row) => row.name));
  const tables = Object.keys(snapshot.tables);
  const missing = tables.filter((table) => !existing.has(table));
  if (missing.length) throw new Error(`The database lacks tables from the backup (${missing.join(', ')}). Run the migrations first.`);

  await run('begin');
  try {
    // Replica mode skips triggers and foreign-key checks, so tables can be loaded in any order.
    await run('set local session_replication_role = replica');
    await run(`truncate ${tables.map((table) => `public.${quote(table)}`).join(', ')} cascade`);
    let restored = 0;
    for (const table of tables) {
      const data = snapshot.tables[table];
      if (!Array.isArray(data) || !data.length) continue;
      await run(
        `insert into public.${quote(table)} overriding system value
         select * from jsonb_populate_recordset(null::public.${quote(table)}, $1::jsonb)`,
        [JSON.stringify(data)]
      );
      restored += data.length;
    }
    // Numbered columns carry on after the restored rows instead of reusing their numbers.
    const { rows: counters } = await run(`select table_name, column_name from information_schema.columns
      where table_schema = 'public' and is_identity = 'YES'`);
    for (const { table_name: table, column_name: column } of counters) {
      if (!tables.includes(table)) continue;
      await run(`select setval(pg_get_serial_sequence($1, $2),
        coalesce((select max(${quote(column)}) from public.${quote(table)}), 0) + 1, false)`, [`public.${quote(table)}`, column]);
    }
    await run('commit');
    return { tables: tables.length, rows: restored };
  } catch (error) {
    await run('rollback');
    throw error;
  }
}
