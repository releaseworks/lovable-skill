// rw-backup Edge function — entrypoint.
// Installed by `releaseworks-skill add backup`. The Releaseworks backend pulls
// from /schema then keyset-paginated /data; this function never calls out.
// Deploy with --no-verify-jwt (backend uses its own auth, not a Supabase JWT).

import { AuthError, verify } from "./auth.ts";
import { buildSchema, fetchPage } from "./introspect.ts";

const SOURCE_ID = Deno.env.get("RW_SOURCE_ID")!;

function json(body: unknown, status = 200): Response {
  // Replacer guards against any stray BigInt (e.g. int8 columns / array members):
  // JSON.stringify can't serialize BigInt and would otherwise 500 the function.
  const serialized = JSON.stringify(body, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  return new Response(serialized, {
    status,
    headers: { "content-type": "application/json" },
  });
}
function err(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

Deno.serve(async (req) => {
  const body = new Uint8Array(await req.arrayBuffer()); // empty for GET
  try {
    await verify(req, body);
  } catch (e) {
    if (e instanceof AuthError) return err(401, e.code, e.message);
    return err(500, "internal", "auth error");
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/rw-backup/, ""); // "/schema" | "/data"

  try {
    if (req.method === "GET" && route === "/schema") {
      return json(await buildSchema(SOURCE_ID));
    }
    if (req.method === "GET" && route === "/data") {
      const table = url.searchParams.get("table");
      const limit = Number(url.searchParams.get("limit"));
      const after = url.searchParams.get("after");
      const schema = url.searchParams.get("schema") || "public";
      if (!table || !limit) return err(400, "bad_request", "table and limit are required");
      const page = await fetchPage(schema, table, after, limit);
      if (page === null) return err(404, "table_not_found", `no such table: ${schema}.${table}`);
      return json(page);
    }
    return err(404, "bad_request", "unknown route");
  } catch (e) {
    return err(500, "internal", String((e as Error).message ?? e));
  }
});
