import { createHash, randomBytes } from "node:crypto";

/** Short, sortable, URL-safe id: time prefix + random suffix. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, "0");
  const r = randomBytes(6).toString("base64url").replace(/[-_]/g, "x");
  return `${prefix}_${t}${r}`;
}

/** Stable JSON encoding (sorted keys) used for hashing approval payloads. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hashPayload(payload: unknown): string {
  return sha256(canonicalJson(payload));
}

export function slugify(text: string, max = 48): string {
  return (
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "project"
  );
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : JSON.stringify(e);
}

/** Read a dotted path such as "result.urls.0" from an object. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function normalizeDomain(input: string | undefined | null): string {
  if (!input) return "";
  let s = input.trim().toLowerCase();
  s = s.replace(/^mailto:/, "");
  if (s.includes("@")) s = s.split("@").pop()!;
  s = s.replace(/^[a-z]+:\/\//, "").split("/")[0]!.split("?")[0]!.split(":")[0]!;
  return s.replace(/^www\./, "");
}

export function normalizeCompanyName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/["'«»“”„.,()]/g, " ")
    .replace(/\b(llc|ltd|limited|inc|corp|co|gmbh|ooo|ооо|оао|зао|jsc|pvt|plc|sa|srl|mchj|xk|ao|ип)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
