import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';
import { cleanPin, hashPin } from './pins.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every counter, with whoever is working on it right now and when it was last used.
export async function listCounters({ database }) {
  const [counters, open, recent] = await Promise.all([
    // '*' so this works before and after migration 0027 adds pin_hash; the hash itself is never sent.
    database.from('counters').select('*').order('name'),
    database.from('shifts').select('counter_id, shift_no, opened_at, cashier:profiles!shifts_cashier_id_fkey(full_name)').eq('status', 'Open'),
    database.from('shifts').select('counter_id, opened_at').order('opened_at', { ascending: false }).limit(500)
  ]);
  const openBy = new Map(unwrap(open).map((row) => [row.counter_id, row]));
  const lastUsed = new Map();
  for (const row of unwrap(recent)) if (!lastUsed.has(row.counter_id)) lastUsed.set(row.counter_id, row.opened_at);
  return unwrap(counters).map((row) => {
    const shift = openBy.get(row.id);
    return {
      id: row.id,
      name: row.name,
      active: row.active,
      hasPin: Boolean(row.pin_hash),
      openShift: shift ? { shiftNo: shift.shift_no, cashier: shift.cashier?.full_name ?? '', openedAt: shift.opened_at } : null,
      lastUsed: lastUsed.get(row.id) ?? null
    };
  });
}

function counterName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 40) throw new HttpError(400, 'Enter a counter name of up to 40 characters.');
  return name;
}

export async function createCounter(clients, user, body) {
  const result = unwrap(await clients.database.rpc('save_counter', { p_id: null, p_name: counterName(body?.name), p_active: true }));
  await writeAudit(clients.database, { user, action: 'Counter added', description: result.name, entityType: 'counter', entityId: result.id });
  return listCounters(clients);
}

export async function updateCounter(clients, user, id, body) {
  if (!UUID.test(id)) throw new HttpError(404, 'Counter not found.');
  if (body?.active !== undefined && typeof body.active !== 'boolean') throw new HttpError(400, 'Invalid counter status.');
  const current = unwrap(await clients.database.from('counters').select('name').eq('id', id).maybeSingle());
  if (!current) throw new HttpError(404, 'Counter not found.');
  const name = body?.name === undefined ? current.name : counterName(body.name);
  const result = unwrap(await clients.database.rpc('save_counter', { p_id: id, p_name: name, p_active: body?.active ?? null }));
  const changes = [];
  if (result.oldName !== result.name) changes.push(`${result.oldName} → ${result.name}`);
  if (result.wasActive !== result.active) changes.push(result.active ? 'switched on' : 'switched off');
  if (changes.length) {
    await writeAudit(clients.database, { user, action: 'Counter changed', description: `${result.name} · ${changes.join(' · ')}`, entityType: 'counter', entityId: id });
  }
  return listCounters(clients);
}

// Sets the counter's PIN, or removes it when `pin` is empty (shifts there then ask for the cashier's password).
export async function setCounterPin(clients, user, id, body) {
  if (!UUID.test(id)) throw new HttpError(404, 'Counter not found.');
  const current = unwrap(await clients.database.from('counters').select('*').eq('id', id).maybeSingle());
  if (!current) throw new HttpError(404, 'Counter not found.');
  if (current.pin_hash === undefined) throw new HttpError(409, 'Counter PINs need the latest database update (0027).');
  const removing = body?.pin === '' || body?.pin === null;
  const pinHash = removing ? null : await hashPin(cleanPin(body?.pin));
  unwrap(await clients.database.from('counters').update({ pin_hash: pinHash }).eq('id', id));
  await writeAudit(clients.database, { user, action: removing ? 'Counter PIN removed' : 'Counter PIN set', description: current.name, entityType: 'counter', entityId: id });
  return listCounters(clients);
}

// The desktop app saves printers on the computer. This keeps a record of who changed them, and where.
export async function recordPrinterChange({ database }, user, body) {
  const roles = ['receipt', 'label', 'document'];
  const changes = Array.isArray(body?.changes) ? body.changes.filter((item) => roles.includes(item?.role)).slice(0, 3) : [];
  if (!changes.length) throw new HttpError(400, 'Nothing changed.');
  const describe = (item) => `${item.role}: ${String(item.printer || 'Windows default').slice(0, 80)}${item.silent ? ' (no dialog)' : ''}`;
  const computer = typeof body?.computer === 'string' ? body.computer.slice(0, 60) : '';
  await writeAudit(database, { user, action: 'Printers changed', description: `${computer ? `${computer} · ` : ''}${changes.map(describe).join(' · ')}` });
}
