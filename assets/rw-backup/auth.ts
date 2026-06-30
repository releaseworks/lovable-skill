// Verifies every request from the Releaseworks backend:
//   1. Bearer token (constant-time)  2. timestamp skew  3. ECDSA signature.
// Fails closed, in order. See contract/edge-function-contract.md §3.

const SKEW_SECONDS = 300;

export class AuthError extends Error {
  constructor(
    public code: string,
    msg: string,
  ) {
    super(msg);
  }
}

const enc = new TextEncoder();

function constantTimeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Mirror Python urlencode(sorted(params.items())) — form-encoded, keys sorted.
function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of url.searchParams) pairs.push([k, v]);
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const formEncode = (s: string) =>
    encodeURIComponent(s)
      .replace(/%20/g, "+")
      .replace(/[!'()*~.]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return pairs.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join("&");
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// DER (ASN.1 SEQUENCE{INTEGER r, INTEGER s}) -> raw r||s (64 bytes, P-256).
// The backend signs with Python `cryptography`, which emits DER; Web Crypto
// verify() wants raw, so we must convert.
function derToRaw(der: Uint8Array): Uint8Array {
  let offset = 2; // skip SEQUENCE tag + length
  if (der[1] & 0x80) offset += der[1] & 0x7f; // long-form length
  const readInt = (): Uint8Array => {
    if (der[offset++] !== 0x02) throw new AuthError("invalid_signature", "bad DER");
    const len = der[offset++];
    let bytes = der.slice(offset, offset + len);
    offset += len;
    while (bytes.length > 32 && bytes[0] === 0x00) bytes = bytes.slice(1);
    const out = new Uint8Array(32);
    out.set(bytes, 32 - bytes.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

let cachedKey: CryptoKey | null = null;
async function publicKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const der = pemToDer(Deno.env.get("RW_PUBLIC_KEY")!);
  cachedKey = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return cachedKey;
}

export async function verify(req: Request, body: Uint8Array): Promise<void> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!constantTimeEqual(token, Deno.env.get("RW_TOKEN") ?? "")) {
    throw new AuthError("unauthorized", "bad bearer token");
  }

  const ts = Number(req.headers.get("x-rw-timestamp") ?? "0");
  if (!ts || Math.abs(Date.now() / 1000 - ts) > SKEW_SECONDS) {
    throw new AuthError("timestamp_skew", "timestamp outside ±300s");
  }

  const url = new URL(req.url);
  const canonical = [
    req.method.toUpperCase(),
    url.pathname,
    canonicalQuery(url),
    String(ts),
    await sha256Hex(body),
  ].join("\n");

  const sigB64url = req.headers.get("x-rw-signature") ?? "";
  const sigDer = Uint8Array.from(atob(sigB64url.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    await publicKey(),
    derToRaw(sigDer),
    enc.encode(canonical),
  );
  if (!ok) throw new AuthError("invalid_signature", "signature verification failed");
}
