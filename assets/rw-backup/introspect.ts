// Read-only schema + data introspection over the project's public schema, plus
// a fixed allowlist of auth tables (auth.users, auth.identities) so user records
// and their linked identities are backed up. Only SELECT/catalog queries are
// ever issued. See the contract, §4–5.

import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

// Connect through the Supavisor transaction pooler when we can, to avoid
// exhausting the customer DB's connection slots (direct connections from an edge
// function are the classic anti-pattern -> "remaining connection slots are
// reserved for ... SUPERUSER"). The pooler host is
// aws-<N>-<region>.pooler.supabase.com; the region comes from SB_REGION but the
// <N> prefix isn't derivable/exposed, so we probe candidates and fall back to a
// single direct connection.
//   - RW_DB_URL set                -> use it verbatim (operator-pinned).
//   - db.<ref>.supabase.co + region -> probe aws-{0,1,2}-<region> pooler URLs.
//   - otherwise / all probes fail   -> direct SUPABASE_DB_URL, pool size 1.
const POOLER_PREFIXES = [0, 1, 2];

function poolerUrl(direct: string, ref: string, region: string, n: number): string {
  const u = new URL(direct);
  u.hostname = `aws-${n}-${region}.pooler.supabase.com`;
  u.port = "6543";
  u.username = `postgres.${ref}`;
  u.searchParams.set("sslmode", "require");
  return u.toString();
}

async function probe(url: string, size: number): Promise<Pool | null> {
  const p = new Pool(url, size, true);
  try {
    const c = await p.connect();
    try {
      await c.queryObject("SELECT 1");
    } finally {
      c.release();
    }
    return p;
  } catch (_e) {
    await p.end().catch(() => {});
    return null;
  }
}

async function resolvePool(): Promise<Pool> {
  const override = Deno.env.get("RW_DB_URL");
  if (override) return new Pool(override, 2, true);

  const direct = Deno.env.get("SUPABASE_DB_URL")!;
  const region = Deno.env.get("SB_REGION");
  const m = new URL(direct).hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  if (region && m) {
    const ref = m[1];
    for (const n of POOLER_PREFIXES) {
      const p = await probe(poolerUrl(direct, ref, region, n), 3);
      if (p) return p;
    }
  }
  // Fallback: direct connection with a minimal footprint.
  return new Pool(direct, 1, true);
}

let _poolPromise: Promise<Pool> | null = null;
function getPool(): Promise<Pool> {
  if (_poolPromise === null) _poolPromise = resolvePool();
  return _poolPromise;
}

// The only non-public tables we back up. auth.* is managed by Supabase/GoTrue,
// so these are DATA-ONLY (no CREATE/indexes/constraints emitted): we insert rows
// into the tables that already exist on any Supabase restore target. Ephemeral
// auth tables (sessions, refresh_tokens, mfa_challenges, flow_state, …) are
// excluded on purpose.
const AUTH_TABLES = ["users", "identities"];

// (schema, table) is allowed for data extraction iff it's a public BASE TABLE or
// one of the auth allowlist tables. Keeps /data from becoming an arbitrary reader.
function isAllowed(schema: string, table: string): boolean {
  return schema === "public" || (schema === "auth" && AUTH_TABLES.includes(table));
}

async function query<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> {
  const pool = await getPool();
  const c = await pool.connect();
  try {
    const r = await c.queryObject<T>({ text: sql, args });
    return r.rows;
  } finally {
    c.release();
  }
}

function encodingFor(udtName: string): "text" | "base64" | "json" {
  if (udtName === "bytea") return "base64";
  if (udtName === "json" || udtName === "jsonb") return "json";
  return "text";
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

export async function buildSchema(sourceId: string) {
  const cols = await query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(`
    SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.udt_name,
           c.is_nullable, c.column_default
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE t.table_type = 'BASE TABLE'
      AND (c.table_schema = 'public'
           OR (c.table_schema = 'auth' AND c.table_name IN ('users', 'identities')))
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
  `);

  const pks = await query<{ table_schema: string; table_name: string; column_name: string }>(`
    SELECT tc.table_schema, tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND (tc.table_schema = 'public'
           OR (tc.table_schema = 'auth' AND tc.table_name IN ('users', 'identities')))
    ORDER BY kcu.ordinal_position
  `);

  // Indexes/constraints/FKs are only emitted for public tables; auth.* is
  // data-only (managed by Supabase), so it gets no DDL.
  const indexes = await query<{ tablename: string; indexdef: string }>(`
    SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'
  `);
  const constraints = await query<{ table_name: string; def: string }>(`
    SELECT rel.relname AS table_name, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = 'public' AND con.contype IN ('f','u','c')
  `);
  const fks = await query<{ table_name: string; ref_table: string }>(`
    SELECT rel.relname AS table_name, fref.relname AS ref_table
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_class fref ON fref.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = 'public' AND con.contype = 'f'
  `);

  // Unique table identity is (schema, name); the contract `name` stays bare and
  // gains a `schema` field. Names don't collide across our public+auth set.
  const ids: { schema: string; name: string }[] = [];
  const seenIds = new Set<string>();
  for (const c of cols) {
    const key = `${c.table_schema}.${c.table_name}`;
    if (!seenIds.has(key)) {
      seenIds.add(key);
      ids.push({ schema: c.table_schema, name: c.table_name });
    }
  }

  const pkByTable = new Map<string, string[]>();
  for (const { table_schema, table_name, column_name } of pks) {
    const key = `${table_schema}.${table_name}`;
    pkByTable.set(key, [...(pkByTable.get(key) ?? []), column_name]);
  }

  const tables = ids.map(({ schema, name }) => {
    const isAuth = schema === "auth";
    const tcols = cols.filter((c) => c.table_schema === schema && c.table_name === name);
    const pk = pkByTable.get(`${schema}.${name}`) ?? [];
    const columnDefs = tcols.map((c) => {
      const type = c.data_type === "ARRAY" ? c.udt_name.replace(/^_/, "") + "[]" : c.data_type;
      let def = `${q(c.column_name)} ${type}`;
      if (c.is_nullable === "NO") def += " NOT NULL";
      if (c.column_default) def += ` DEFAULT ${c.column_default}`;
      return def;
    });
    if (pk.length) columnDefs.push(`PRIMARY KEY (${pk.map(q).join(", ")})`);

    // auth.* is data-only: no CREATE / indexes / constraints.
    const post_ddl = isAuth
      ? []
      : [
          ...indexes
            .filter((i) => i.tablename === name && !/_pkey/.test(i.indexdef))
            .map((i) => i.indexdef + ";"),
          ...constraints
            .filter((c) => c.table_name === name)
            .map((c) => `ALTER TABLE public.${q(name)} ADD ${c.def};`),
        ];

    return {
      name,
      schema,
      primary_key: pk,
      create_ddl: isAuth
        ? null
        : `CREATE TABLE public.${q(name)} (\n  ${columnDefs.join(",\n  ")}\n);`,
      post_ddl,
      fk_dependencies: isAuth
        ? []
        : fks.filter((f) => f.table_name === name).map((f) => f.ref_table),
      columns: tcols.map((c) => ({
        name: c.column_name,
        pg_type: c.data_type === "ARRAY" ? c.udt_name.replace(/^_/, "") + "[]" : c.udt_name,
        encoding: encodingFor(c.udt_name),
      })),
      approx_row_count: 0,
    };
  });

  return {
    schema_version: 1,
    source_id: sourceId,
    generated_at: new Date().toISOString(),
    restore_order: topoSort(
      ids.map((t) => t.name),
      fks,
    ),
    tables,
  };
}

function topoSort(names: string[], fks: { table_name: string; ref_table: string }[]): string[] {
  const deps = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  for (const { table_name, ref_table } of fks) {
    // Only record a dependency when BOTH tables are enumerated. A FK to a table
    // we don't back up (e.g. a cross-schema ref to an excluded auth table) must
    // not leak a phantom node into restore_order.
    if (table_name !== ref_table && deps.has(table_name) && deps.has(ref_table)) {
      deps.get(table_name)!.add(ref_table);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string, stack: Set<string>) => {
    if (seen.has(n) || stack.has(n)) return;
    stack.add(n);
    for (const d of deps.get(n) ?? []) visit(d, stack);
    stack.delete(n);
    seen.add(n);
    out.push(n);
  };
  for (const n of names) visit(n, new Set());
  return out;
}

export async function fetchPage(
  schema: string,
  table: string,
  after: string | null,
  limit: number,
) {
  // Gate to the same allowlist as buildSchema so /data can't read arbitrary
  // schemas/tables.
  if (!isAllowed(schema, table)) return null;

  const exists = await query<{ ok: boolean }>(
    `SELECT true AS ok FROM information_schema.tables
     WHERE table_schema=$1 AND table_type='BASE TABLE' AND table_name = $2`,
    [schema, table],
  );
  if (!exists.length) return null;

  const pks = await query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema=$1 AND tc.constraint_type='PRIMARY KEY'
       AND tc.table_name = $2
     ORDER BY kcu.ordinal_position`,
    [schema, table],
  );
  if (!pks.length) throw new Error(`table ${schema}.${table} has no primary key`);

  const pkCols = pks.map((p) => p.column_name);
  const orderBy = pkCols.map(q).join(", ");
  const where = after !== null ? `WHERE ${q(pkCols[0])} > $1` : "";
  const args = after !== null ? [after] : [];
  const rows = await query(
    `SELECT * FROM ${q(schema)}.${q(table)} ${where} ORDER BY ${orderBy} LIMIT ${Number(limit)}`,
    args,
  );

  const encoded = rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (v === null) o[k] = null;
      else if (v instanceof Uint8Array) o[k] = btoa(String.fromCharCode(...v));
      else if (typeof v === "bigint") o[k] = v.toString(); // int8 -> string (JSON-safe)
      else o[k] = v;
    }
    return o;
  });

  const last = encoded.length ? encoded[encoded.length - 1] : null;
  return {
    table,
    rows: encoded,
    last_id: last ? last[pkCols[0]] : null,
    has_more: rows.length === Number(limit),
    page_bytes: 0,
  };
}
