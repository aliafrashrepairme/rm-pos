import { selectAll } from '../db.js';
import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';
import { toCsv } from './csv.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function buildFilter(database, query) {
  const fromDate = query.from || null;
  const toDate = query.to || null;
  if ((fromDate && !DATE.test(fromDate)) || (toDate && !DATE.test(toDate))) throw new HttpError(400, 'Choose a valid date range.');
  const period = unwrap(await database.rpc('report_period', { p_preset: query.preset ?? 'last30', p_from: fromDate, p_to: toDate }));
  const search = typeof query.q === 'string' ? query.q.replace(/[%*_\\"]/g, ' ').trim().slice(0, 100) : '';
  return (request) => {
    let filtered = request.gte('created_at', period.start).lt('created_at', period.end);
    if (query.action) filtered = filtered.eq('action', String(query.action).slice(0, 100));
    if (search) filtered = filtered.or(`user_name.ilike."*${search}*",action.ilike."*${search}*",description.ilike."*${search}*",entity_id.ilike."*${search}*"`);
    return filtered;
  };
}

function asEntry(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    user: row.user_name,
    action: row.action,
    description: row.description,
    entityType: row.entity_type,
    entityId: row.entity_id
  };
}

export async function listAudit({ database }, query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 50, 1), 100);
  const filter = await buildFilter(database, query);
  const { data, count, error } = await filter(database.from('audit_logs').select('id, created_at, user_name, action, description, entity_type, entity_id', { count: 'exact' }))
    .order('id', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  unwrap({ data, error });
  return { entries: data.map(asEntry), total: count ?? data.length, page, pageSize };
}

export async function auditActions({ database }) {
  return unwrap(await database.rpc('audit_actions'));
}

export async function exportAudit({ database }, user, query) {
  const filter = await buildFilter(database, query);
  const rows = await selectAll(() => filter(database.from('audit_logs').select('id, created_at, user_name, action, description, entity_type, entity_id')).order('id', { ascending: false }));
  await writeAudit(database, { user, action: 'Data exported', description: `audit log: ${rows.length} rows`, entityType: 'export', entityId: 'audit' });
  return toCsv([
    ['date', (row) => row.created_at], ['user', (row) => row.user_name], ['action', (row) => row.action], ['description', (row) => row.description],
    ['record_type', (row) => row.entity_type], ['record_id', (row) => row.entity_id]
  ], rows);
}
