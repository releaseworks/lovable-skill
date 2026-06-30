// rw-sync Edge function — receives the packaged codebase from the local
// send-codebase script and relays it to Releaseworks, authenticating with the
// per-source token it reads from its own Supabase secrets. This is why the
// script needs no Releaseworks secret: the secret lives here, in the function.
//
// Deploy WITH JWT verification (the Supabase default — do NOT pass
// --no-verify-jwt). Supabase validates the project anon key the script sends
// before this code runs, so we don't re-check it here.

const SOURCE_ID = Deno.env.get("RW_SOURCE_ID")!;
const TOKEN = Deno.env.get("RW_TOKEN")!;
const BACKEND = (Deno.env.get("RW_BACKEND") ?? "https://api.prod.releaseworks.ai").replace(/\/$/, "");

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: { code: "method_not_allowed", message: "use POST" } }, 405);
  }
  if (!SOURCE_ID || !TOKEN) {
    return json({ error: { code: "misconfigured", message: "RW_SOURCE_ID/RW_TOKEN not set" } }, 500);
  }

  const body = new Uint8Array(await req.arrayBuffer());
  try {
    const resp = await fetch(`${BACKEND}/v1/code/snapshots`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "X-RW-Source-ID": SOURCE_ID,
        "Content-Type": "application/gzip",
      },
      body,
    });
    // Pass the backend's status + body straight back to the caller.
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
    });
  } catch (e) {
    return json({ error: { code: "relay_failed", message: String((e as Error).message ?? e) } }, 502);
  }
});
