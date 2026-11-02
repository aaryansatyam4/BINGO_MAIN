/**
 * Owner session: an HMAC-signed, expiring cookie. Web Crypto only, so it works
 * in the request proxy and in route handlers alike.
 */
export const SESSION_COOKIE = "bingo_session";
const enc = new TextEncoder();

function secret(): string {
  return process.env.BINGO_SESSION_SECRET || process.env.BINGO_MASTER_KEY || (process.env.NODE_ENV !== "production" ? "dev-only-session-secret" : "");
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Buffer.from(sig).toString("base64url");
}

export async function createSession(days = 14): Promise<string> {
  const exp = String(Date.now() + days * 864e5);
  return `${exp}.${await hmac(`owner:${exp}`)}`;
}

export async function verifySession(token: string | undefined): Promise<boolean> {
  if (!token || !secret()) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = await hmac(`owner:${exp}`);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function authMode(): "password" | "open-dev" | "misconfigured" {
  if (process.env.BINGO_OWNER_PASSWORD) return "password";
  return process.env.NODE_ENV === "production" ? "misconfigured" : "open-dev";
}

export async function checkPassword(input: string): Promise<boolean> {
  const want = process.env.BINGO_OWNER_PASSWORD ?? "";
  if (!want || !input) return false;
  const a = await hmac(`pw:${input}`);
  const b = await hmac(`pw:${want}`);
  return a === b;
}
