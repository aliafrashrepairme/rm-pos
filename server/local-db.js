import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { bundleMigrations } from './scripts/bundle-migrations.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Where the installed desktop app keeps its database (electron/main.cjs sets the same path).
export function desktopDatabasePath(env = process.env) {
  const roaming = env.APPDATA || path.join(env.USERPROFILE || env.HOME || '.', 'AppData', 'Roaming');
  return path.join(roaming, 'RM POS', 'database');
}

// Only one program may open the database folder at a time; the app's server answers on port 4000.
export async function assertAppClosed(port = 4000) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
  } catch {
    return;
  }
  throw new Error('RM POS is running. Close it completely (check Task Manager), then run this again.');
}

function quote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function pgValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [kind, salt, expected] = String(stored || '').split(':');
  if (kind !== 'scrypt') return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function splitColumns(value) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

const OR_OPERATORS = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE', is: 'IS' };

// Splits on commas that aren't inside double quotes.
function splitOrConditions(expression) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === '\\' && quoted) {
      current += char + (expression[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function parseOrFilter(expression) {
  return splitOrConditions(String(expression ?? '')).map((condition) => {
    const match = condition.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([a-z]+)\.(.*)$/s);
    if (!match || !OR_OPERATORS[match[2]]) throw new Error(`Unsupported filter: ${condition}`);
    const [, column, op, raw] = match;
    let value = raw;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    if (op === 'like' || op === 'ilike') value = value.replaceAll('*', '%');
    if (op === 'is') {
      const keyword = value.toLowerCase();
      if (!['null', 'true', 'false'].includes(keyword)) throw new Error(`Unsupported filter: ${condition}`);
      value = keyword;
    }
    return { column, operator: OR_OPERATORS[op], value };
  });
}

// With a hint, follow the link with that constraint name or local column; otherwise the first link.
function pickConstraint(rows, hint) {
  if (!hint) return rows[0] || null;
  return rows.find((row) => row.conname === hint || row.local_column === hint) || null;
}

class LocalAuth {
  constructor(db) {
    this.db = db;
    this.sessions = new Map();
    this.admin = {
      signOut: async () => ({ error: null }),
      createUser: async ({ email, password }) => {
        const id = crypto.randomUUID();
        const result = await db.query(
          'insert into auth.users(id, email, encrypted_password) values($1, $2, $3) returning id, email',
          [id, email, hashPassword(password)]
        );
        return { data: { user: result.rows[0] }, error: null };
      },
      deleteUser: async (id) => {
        await db.query('delete from auth.users where id=$1', [id]);
        return { error: null };
      },
      updateUserById: async (id, changes) => {
        const sets = [];
        const params = [];
        if (changes.email !== undefined) {
          params.push(changes.email);
          sets.push(`email=$${params.length}`);
        }
        if (changes.password !== undefined) {
          params.push(hashPassword(changes.password));
          sets.push(`encrypted_password=$${params.length}`);
        }
        if (!sets.length) return { error: null };
        params.push(id);
        await db.query(`update auth.users set ${sets.join(', ')} where id=$${params.length}`, params);
        return { error: null };
      },
      signOut: async (token) => {
        this.sessions.delete(token);
        return { error: null };
      }
    };
  }

  auth = {
    signInWithPassword: async ({ email, password }) => {
      const result = await this.db.query(
        'select id, email, encrypted_password from auth.users where lower(email)=lower($1)',
        [email]
      );
      const user = result.rows[0];
      if (!user || !verifyPassword(password, user.encrypted_password)) {
        return { data: {}, error: { name: 'InvalidLoginCredentials', message: 'Invalid login credentials' } };
      }
      const accessToken = crypto.randomBytes(32).toString('hex');
      const refreshToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 12;
      this.sessions.set(accessToken, { user: { id: user.id, email: user.email }, refreshToken, expiresAt });
      this.sessions.set(refreshToken, { user: { id: user.id, email: user.email }, refreshToken, expiresAt });
      return {
        data: {
          user: { id: user.id, email: user.email },
          session: { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt }
        },
        error: null
      };
    },
    refreshSession: async ({ refresh_token: refreshToken }) => {
      const existing = this.sessions.get(refreshToken);
      if (!existing) return { data: {}, error: { message: 'Refresh token expired' } };
      const accessToken = crypto.randomBytes(32).toString('hex');
      const nextRefresh = crypto.randomBytes(32).toString('hex');
      const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 12;
      this.sessions.delete(refreshToken);
      this.sessions.set(accessToken, { user: existing.user, refreshToken: nextRefresh, expiresAt });
      this.sessions.set(nextRefresh, { user: existing.user, refreshToken: nextRefresh, expiresAt });
      return {
        data: {
          user: existing.user,
          session: { access_token: accessToken, refresh_token: nextRefresh, expires_at: expiresAt }
        },
        error: null
      };
    },
    getUser: async (token) => {
      const session = this.sessions.get(token);
      if (!session || session.expiresAt < Math.floor(Date.now() / 1000)) {
        return { data: {}, error: { message: 'Session expired' } };
      }
      return { data: { user: session.user }, error: null };
    }
  };
}

class LocalQuery {
  constructor(db, table, operation = 'select', payload) {
    this.db = db;
    this.table = table;
    this.operation = operation;
    this.payload = payload;
    this.filters = [];
    this.ordering = [];
    this.limitValue = null;
    this.offsetValue = null;
    this.selectColumns = '*';
  }

  select(columns = '*', options = {}) {
    if (this.operation === 'insert' || this.operation === 'update') this.operation = `${this.operation}_select`;
    else this.operation = 'select';
    this.selectColumns = columns;
    this.options = options;
    return this;
  }

  insert(rows) {
    this.operation = 'insert';
    this.payload = rows;
    return this;
  }

  update(values) {
    this.operation = 'update';
    this.payload = values;
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  eq(column, value) { this.filters.push({ column, operator: '=', value }); return this; }
  neq(column, value) { this.filters.push({ column, operator: '!=', value }); return this; }
  gte(column, value) { this.filters.push({ column, operator: '>=', value }); return this; }
  gt(column, value) { this.filters.push({ column, operator: '>', value }); return this; }
  lte(column, value) { this.filters.push({ column, operator: '<=', value }); return this; }
  lt(column, value) { this.filters.push({ column, operator: '<', value }); return this; }
  like(column, value) { this.filters.push({ column, operator: 'LIKE', value }); return this; }
  ilike(column, value) { this.filters.push({ column, operator: 'ILIKE', value }); return this; }
  in(column, values) { this.filters.push({ column, operator: 'IN', value: values }); return this; }
  is(column, value) { this.filters.push({ column, operator: 'IS', value }); return this; }
  // Supabase-style "col.op.value,col.op.value": any one condition may match.
  or(expression) { this.filters.push({ operator: 'OR', value: expression }); return this; }
  not(column, operator, value) { this.filters.push({ column, operator: `NOT ${operator}`, value }); return this; }
  order(column, options = {}) { this.ordering.push({ column, ascending: options.ascending !== false }); return this; }
  limit(value) { this.limitValue = value; return this; }
  range(from, to) { this.offsetValue = from; this.limitValue = to - from + 1; return this; }

  filterSql(params) {
    if (!this.filters.length) return '';
    const clauses = this.filters.map((filter) => {
      if (filter.operator === 'OR') {
        const conditions = parseOrFilter(filter.value);
        if (!conditions.length) return 'false';
        return `(${conditions.map((part) => {
          if (part.operator === 'IS') return `${quote(part.column)} is ${part.value}`;
          params.push(part.value);
          return `${quote(part.column)} ${part.operator} $${params.length}`;
        }).join(' or ')})`;
      }
      if (filter.operator === 'IN') {
        if (!filter.value.length) return 'false';
        const placeholders = filter.value.map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        return `${quote(filter.column)} in (${placeholders.join(', ')})`;
      }
      if (filter.operator === 'IS' && filter.value === null) {
        return `${quote(filter.column)} is null`;
      }
      params.push(filter.value);
      return `${quote(filter.column)} ${filter.operator} $${params.length}`;
    });
    return ` where ${clauses.join(' and ')}`;
  }

  // Keeps the requested columns plus the related objects added under their aliases.
  trimRow(row) {
    const keep = new Set(this.projection);
    for (const item of splitColumns(this.selectColumns)) {
      const match = item.match(/^([^:(]+:)?\s*([A-Za-z_][A-Za-z0-9_]*)(?:![^(]+)?\(/s);
      if (match) keep.add(match[1]?.slice(0, -1).trim() || match[2]);
    }
    return Object.fromEntries(Object.entries(row).filter(([key]) => keep.has(key)));
  }

  async enrichRelations(rows) {
    if (!rows.length || this.selectColumns === '*') return rows;
    for (const item of splitColumns(this.selectColumns)) {
      const match = item.match(/^([^:]+:)?\s*([A-Za-z_][A-Za-z0-9_]*)(?:!([^(]+))?\((.*)\)$/s);
      if (!match) continue;
      const alias = match[1]?.slice(0, -1).trim() || match[2];
      const relationTable = match[2];
      // "!name" picks which link to follow when a table points at another more than once.
      const hint = match[3] && !['inner', 'left'].includes(match[3].trim()) ? match[3].trim() : null;
      const relationColumns = splitColumns(match[4]).filter((column) => !column.includes('('));
      if (!relationColumns.length) continue;

      for (const row of rows) {
        const mainConstraints = await this.db.query(`
          select c.conname, a.attname as local_column, af.attname as remote_column
          from pg_constraint c
          join unnest(c.conkey) with ordinality k(attnum, ord) on true
          join unnest(c.confkey) with ordinality fk(attnum, ord) on k.ord=fk.ord
          join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
          join pg_attribute af on af.attrelid=c.confrelid and af.attnum=fk.attnum
          where c.contype='f' and c.conrelid=$1::regclass and c.confrelid=$2::regclass
        `, [this.table, relationTable]).catch(() => ({ rows: [] }));

        const mainConstraint = pickConstraint(mainConstraints.rows, hint);
        if (mainConstraint) {
          const constraint = mainConstraint;
          const value = row[constraint.local_column];
          if (value === undefined) continue;
          const relation = await this.db.query(
            `select ${relationColumns.map(quote).join(', ')} from ${quote(relationTable)} where ${quote(constraint.remote_column)}=$1 limit 1`,
            [value]
          ).catch(() => ({ rows: [] }));
          row[alias] = relation.rows[0] || null;
          continue;
        }

        const reverseConstraints = await this.db.query(`
          select c.conname, a.attname as local_column, af.attname as remote_column
          from pg_constraint c
          join unnest(c.conkey) with ordinality k(attnum, ord) on true
          join unnest(c.confkey) with ordinality fk(attnum, ord) on k.ord=fk.ord
          join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
          join pg_attribute af on af.attrelid=c.confrelid and af.attnum=fk.attnum
          where c.contype='f' and c.conrelid=$1::regclass and c.confrelid=$2::regclass
        `, [relationTable, this.table]).catch(() => ({ rows: [] }));

        const reverseConstraint = pickConstraint(reverseConstraints.rows, hint);
        if (reverseConstraint) {
          const constraint = reverseConstraint;
          const value = row[constraint.remote_column];
          if (value === undefined) continue;
          const relation = await this.db.query(
            `select ${relationColumns.map(quote).join(', ')} from ${quote(relationTable)} where ${quote(constraint.local_column)}=$1`,
            [value]
          ).catch(() => ({ rows: [] }));
          row[alias] = relation.rows;
        }
      }
    }
    return rows;
  }

  async execute() {
    try {
      const params = [];
      let sql;
      if (this.operation === 'select') {
        const baseColumns = this.selectColumns === '*' ? ['*'] : splitColumns(this.selectColumns)
          .filter((item) => !item.includes('('))
          .map((item) => item.includes(':') ? item.split(':')[0].trim() : item.trim());
        // Related rows are found through link columns (e.g. cashier_id) the caller may not have
        // asked for, so fetch every column and trim back to the requested ones afterwards.
        const hasRelations = this.selectColumns !== '*' && splitColumns(this.selectColumns).some((item) => item.includes('('));
        this.projection = hasRelations && !baseColumns.includes('*') ? baseColumns : null;
        const fetched = hasRelations || !baseColumns.length ? ['*'] : baseColumns;
        sql = `select ${fetched.map((item) => item === '*' ? '*' : quote(item)).join(', ')} from ${quote(this.table)}`;
        sql += this.filterSql(params);
        if (this.ordering.length) {
          sql += ` order by ${this.ordering.map((item) => `${quote(item.column)} ${item.ascending ? 'asc' : 'desc'}`).join(', ')}`;
        }
        if (this.limitValue !== null) sql += ` limit ${Number(this.limitValue)}`;
        if (this.offsetValue !== null) sql += ` offset ${Number(this.offsetValue)}`;
      } else if (this.operation === 'insert') {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
        if (!rows.length) return { data: [], error: null };
        const columns = Object.keys(rows[0]);
        const values = [];
        rows.forEach((row) => {
          values.push(`(${columns.map((column) => { params.push(row[column]); return `$${params.length}`; }).join(', ')})`);
        });
        sql = `insert into ${quote(this.table)} (${columns.map(quote).join(', ')}) values ${values.join(', ')}`;
        if (this.selectColumns !== '*' || this.operation.endsWith('_select')) sql += ` returning *`;
      } else if (this.operation === 'insert_select') {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
        if (!rows.length) return { data: [], error: null };
        const columns = Object.keys(rows[0]);
        const values = columns.map((column) => { params.push(rows[0][column]); return `$${params.length}`; });
        sql = `insert into ${quote(this.table)} (${columns.map(quote).join(', ')}) values (${values.join(', ')}) returning *`;
      } else if (this.operation === 'update') {
        const entries = Object.entries(this.payload);
        const sets = entries.map(([column, value]) => { params.push(value); return `${quote(column)}=$${params.length}`; });
        sql = `update ${quote(this.table)} set ${sets.join(', ')}`;
        sql += this.filterSql(params);
      } else if (this.operation === 'update_select') {
        const entries = Object.entries(this.payload);
        const sets = entries.map(([column, value]) => { params.push(value); return `${quote(column)}=$${params.length}`; });
        sql = `update ${quote(this.table)} set ${sets.join(', ')}`;
        sql += this.filterSql(params);
        sql += ' returning *';
      } else if (this.operation === 'delete') {
        sql = `delete from ${quote(this.table)}`;
        sql += this.filterSql(params);
        sql += ' returning *';
      }

      const result = await this.db.query(sql, params);
      let data = result.rows;
      if (this.operation === 'select' && this.table === 'profiles' && this.selectColumns.includes('roles(')) {
        data = await Promise.all(data.map(async (row) => {
          const role = await this.db.query(
            'select rp.permission_code from role_permissions rp where rp.role_code=$1',
            [row.role_code]
          );
          return { ...row, roles: { role_permissions: role.rows.map((item) => ({ permission_code: item.permission_code })) } };
        }));
      }
      if (this.operation === 'select') {
        data = await this.enrichRelations(data);
        if (this.projection) data = data.map((row) => this.trimRow(row));
      }
      if (this.options?.count === 'exact') {
        const countParams = [];
        const countWhere = this.filterSql(countParams);
        const countResult = await this.db.query(`select count(*)::int as count from ${quote(this.table)}${countWhere}`, countParams);
        return { data: this.operation === 'select' ? data : (data.length === 1 ? data[0] : data), count: countResult.rows[0]?.count, error: null };
      }
      if (this.operation === 'select') return { data, error: null };
      if (this.operation === 'delete') return { data, error: null };
      return { data: data.length === 1 ? data[0] : data, error: null };
    } catch (error) {
      return { data: null, error: { code: error.code, message: error.message } };
    }
  }

  then(resolve, reject) { return this.execute().then(resolve, reject); }
  maybeSingle() { return this.single(true); }
  single(allowMissing = false) {
    this.limitValue = 1;
    const original = this.execute.bind(this);
    this.execute = async () => {
      const result = await original();
      if (result.error) return result;
      const row = Array.isArray(result.data) ? result.data[0] ?? null : result.data;
      if (!allowMissing && row === null) return { data: null, error: { code: 'PGRST116', message: 'No rows found' } };
      return { data: row, error: null };
    };
    return this;
  }
}

export async function createLocalClients(config) {
  const dbPath = config.localDbPath || path.join(here, 'data', 'rm-pos-pglite');
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new PGlite(dbPath);
  await db.exec(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key,
      email text,
      encrypted_password text,
      raw_user_meta_data jsonb default '{}'::jsonb
    );
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
    end $$;
    create or replace function public.similarity(text, text) returns real
    language sql immutable as $function$
      select case
        when coalesce($1, '') = '' or coalesce($2, '') = '' then 0
        when lower($1) = lower($2) then 1
        when lower($1) like '%' || lower($2) || '%' or lower($2) like '%' || lower($1) || '%' then 0.8
        else 0
      end::real
    $function$;
  `);

  // Built from the committed migration files, so a fresh checkout needs no generated SQL file.
  const { sql: migration } = await bundleMigrations();
  const localMigration = migration
    .replace(/create extension if not exists pg_trgm[^;]*;/gi, '')
    .replace(/create index[^\n]*gin[^\n]*;/gi, '');

  const tables = await db.query("select count(*)::int as count from pg_tables where schemaname='public'");
  if (tables.rows[0].count === 0) await db.exec(localMigration);

  const auth = new LocalAuth(db);

  const profileCount = await db.query('select count(*)::int as count from public.profiles');
  if (profileCount.rows[0].count === 0) {
    const accounts = [
      ['owner', 'Owner@123456', 'System Owner', 'Owner'],
      ['manager', 'Manager@123456', 'System Manager', 'Manager'],
      ['inventory', 'Inventory@123456', 'Inventory Staff', 'Inventory Staff'],
      ['cashier', 'Cashier@123456', 'System Cashier', 'Cashier']
    ];
    for (const [username, password, fullName, roleCode] of accounts) {
      const id = crypto.randomUUID();
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
      const email = `${username}@staff.rm-pos.local`;
      await db.query(
        'insert into auth.users(id,email,encrypted_password) values($1,$2,$3)',
        [id, email, `scrypt:${salt}:${passwordHash}`]
      );
      await db.query(
        `insert into public.profiles(id,username,full_name,email,role_code,active,must_change_password)
         values($1,$2,$3,$4,$5,true,false)`,
        [id, username, fullName, email, roleCode]
      );
    }
  }

  const database = {
    auth: { admin: auth.admin },
    from(table) { return new LocalQuery(db, table); },
    rpc: async (name, params = {}) => {
      try {
        const entries = Object.entries(params);
        const placeholders = entries.map(([,], index) => `$${index + 1}`);
        const args = entries.length
          ? entries.map(([key], index) => `${key} => ${placeholders[index]}`).join(', ')
          : '';
        const result = await db.query(`select * from ${quote(name)}(${args})`, entries.map(([, value]) => value));
        if (result.rows.length === 1) {
          const keys = Object.keys(result.rows[0]);
          if (keys.length === 1) return { data: result.rows[0][keys[0]], error: null };
        }
        return { data: result.rows, error: null };
      } catch (error) {
        return { data: null, error: { code: error.code, message: error.message } };
      }
    },
    _pglite: db
  };

  return { authClient: auth, database };
}
