// Read-only schema + data introspection over the project's public schema.
// Only SELECT/catalog queries are ever issued. See the contract, §4–5.

import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const pool = new Pool(Deno.env.get("SUPABASE_DB_URL")!, 3, true);

async function query<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> {
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
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(`
    SELECT c.table_name, c.column_name, c.data_type, c.udt_name,
           c.is_nullable, c.column_default
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position
  `);

  const pks = await query<{ table_name: string; column_name: string }>(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position
  `);

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

  const tableNames = [...new Set(cols.map((c) => c.table_name))];
  const pkByTable = new Map<string, string[]>();
  for (const { table_name, column_name } of pks) {
    pkByTable.set(table_name, [...(pkByTable.get(table_name) ?? []), column_name]);
  }

  const tables = tableNames.map((name) => {
    const tcols = cols.filter((c) => c.table_name === name);
    const pk = pkByTable.get(name) ?? [];
    const columnDefs = tcols.map((c) => {
      const type = c.data_type === "ARRAY" ? c.udt_name.replace(/^_/, "") + "[]" : c.data_type;
      let def = `${q(c.column_name)} ${type}`;
      if (c.is_nullable === "NO") def += " NOT NULL";
      if (c.column_default) def += ` DEFAULT ${c.column_default}`;
      return def;
    });
    if (pk.length) columnDefs.push(`PRIMARY KEY (${pk.map(q).join(", ")})`);

    const post_ddl = [
      ...indexes
        .filter((i) => i.tablename === name && !/_pkey/.test(i.indexdef))
        .map((i) => i.indexdef + ";"),
      ...constraints
        .filter((c) => c.table_name === name)
        .map((c) => `ALTER TABLE public.${q(name)} ADD ${c.def};`),
    ];

    return {
      name,
      primary_key: pk,
      create_ddl: `CREATE TABLE public.${q(name)} (\n  ${columnDefs.join(",\n  ")}\n);`,
      post_ddl,
      fk_dependencies: fks.filter((f) => f.table_name === name).map((f) => f.ref_table),
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
    restore_order: topoSort(tableNames, fks),
    tables,
  };
}

function topoSort(names: string[], fks: { table_name: string; ref_table: string }[]): string[] {
  const deps = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  for (const { table_name, ref_table } of fks) {
    if (table_name !== ref_table && deps.has(table_name)) deps.get(table_name)!.add(ref_table);
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

export async function fetchPage(table: string, after: string | null, limit: number) {
  const exists = await query<{ ok: boolean }>(
    `SELECT true AS ok FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name = $1`,
    [table],
  );
  if (!exists.length) return null;

  const pks = await query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
     WHERE tc.table_schema='public' AND tc.constraint_type='PRIMARY KEY'
       AND tc.table_name = $1
     ORDER BY kcu.ordinal_position`,
    [table],
  );
  if (!pks.length) throw new Error(`table ${table} has no primary key`);

  const pkCols = pks.map((p) => p.column_name);
  const orderBy = pkCols.map(q).join(", ");
  const where = after !== null ? `WHERE ${q(pkCols[0])} > $1` : "";
  const args = after !== null ? [after] : [];
  const rows = await query(
    `SELECT * FROM public.${q(table)} ${where} ORDER BY ${orderBy} LIMIT ${Number(limit)}`,
    args,
  );

  const encoded = rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (v === null) o[k] = null;
      else if (v instanceof Uint8Array) o[k] = btoa(String.fromCharCode(...v));
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
