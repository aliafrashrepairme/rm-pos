import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import test from 'node:test';

const entry = fileURLToPath(new URL('../index.js', import.meta.url));

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForApi(baseUrl, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API process exited with ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('API did not start in time.');
}

test('API starts with Supabase configuration and reports its storage provider', async (t) => {
  const port = await availablePort();
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PORT: String(port),
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key'
    },
    stdio: 'ignore'
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });

  const health = await waitForApi(`http://127.0.0.1:${port}`, child);
  assert.deepEqual(health, { ok: true, service: 'rm-pos-server', storage: 'supabase' });
});

test('Supabase schema defines protected tables and transactional stock operations', async () => {
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  for (const table of ['profiles', 'products', 'sales', 'sale_items', 'stock_movements', 'suppliers', 'purchases', 'purchase_items']) {
    assert.match(schema, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(schema, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  for (const operation of ['create_product', 'adjust_stock', 'create_sale', 'receive_purchase']) {
    assert.match(schema, new RegExp(`function public\\.${operation}\\(`));
  }
});