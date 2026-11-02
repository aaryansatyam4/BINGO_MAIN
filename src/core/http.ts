import type { Ctx } from "./context";

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

export interface JsonRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
}

/** fetch + JSON + timeout + readable errors. Uses ctx.fetch so tests can fake every provider. */
export async function fetchJson<T = unknown>(ctx: Pick<Ctx, "fetch">, url: string, req: JsonRequest = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...(req.headers ?? {}) };
  let body: BodyInit | undefined;
  if (req.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(req.form).toString();
  } else if (req.body !== undefined) {
    headers["content-type"] ??= "application/json";
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  const res = await ctx.fetch(url, {
    method: req.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}
