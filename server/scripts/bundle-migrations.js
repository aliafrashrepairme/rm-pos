// Joins every migration into one file, to paste once into a brand-new Supabase project's SQL Editor.
// Usage: npm --prefix server run db:bundle
// Never run the result on a database that already has these tables.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const folder = new URL('../supabase/migrations/', import.meta.url);

export async function bundleMigrations() {
  const names = (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort();
  const parts = await Promise.all(names.map(async (name) => `-- ===== ${name} =====\n${await readFile(new URL(name, folder), 'utf8')}`));
  return { names, sql: parts.join('\n') };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { names, sql } = await bundleMigrations();
  const target = new URL('../supabase/fresh-project.sql', import.meta.url);
  await writeFile(target, sql);
  console.log(`Joined ${names.length} migrations into ${fileURLToPath(target)}`);
}
