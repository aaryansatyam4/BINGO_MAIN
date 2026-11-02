import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * BINGO's durable document store. Every record lives in a named collection and
 * carries an optimistic-concurrency version (`_v`). Production uses Postgres
 * (DATABASE_URL); local development uses JSON files; tests use memory.
 */
export interface StoredMeta {
  _v: number;
  _updatedAt: string;
}
export type Stored<T> = T & StoredMeta;

export interface ListOptions {
  /** Shallow equality filter on top-level fields. */
  where?: Record<string, unknown>;
  limit?: number;
  /** Newest first by _updatedAt (default true). */
  newestFirst?: boolean;
}

export class ConflictError extends Error {
  constructor(collection: string, id: string) {
    super(`Version conflict on ${collection}/${id}`);
    this.name = "ConflictError";
  }
}

export interface Store {
  readonly kind: "memory" | "file" | "postgres";
  get<T>(collection: string, id: string): Promise<Stored<T> | null>;
  /** Insert or replace. With expectVersion, fails with ConflictError unless the stored version matches (0 = must not exist). */
  put<T extends { id: string }>(collection: string, doc: T, opts?: { expectVersion?: number }): Promise<Stored<T>>;
  list<T>(collection: string, opts?: ListOptions): Promise<Stored<T>[]>;
  delete(collection: string, id: string): Promise<void>;
}

function matches(doc: Record<string, unknown>, where?: Record<string, unknown>): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => doc[k] === v);
}

function sortAndLimit<T extends StoredMeta>(rows: T[], opts?: ListOptions): T[] {
  const newest = opts?.newestFirst ?? true;
  rows.sort((a, b) => (newest ? b._updatedAt.localeCompare(a._updatedAt) : a._updatedAt.localeCompare(b._updatedAt)));
  return opts?.limit ? rows.slice(0, opts.limit) : rows;
}

/** Monotonic ISO timestamps so ordering is stable even within one millisecond. */
let lastStamp = 0;
function stamp(): string {
  const now = Math.max(Date.now(), lastStamp + 1);
  lastStamp = now;
  return new Date(now).toISOString();
}

export class MemoryStore implements Store {
  readonly kind: "memory" | "file" = "memory";
  protected data = new Map<string, Map<string, Stored<Record<string, unknown>>>>();

  protected col(name: string) {
    let c = this.data.get(name);
    if (!c) this.data.set(name, (c = new Map()));
    return c;
  }
  async get<T>(collection: string, id: string): Promise<Stored<T> | null> {
    const d = this.col(collection).get(id);
    return d ? (structuredClone(d) as Stored<T>) : null;
  }
  async put<T extends { id: string }>(collection: string, doc: T, opts?: { expectVersion?: number }): Promise<Stored<T>> {
    const c = this.col(collection);
    const cur = c.get(doc.id);
    const curV = cur?._v ?? 0;
    if (opts?.expectVersion !== undefined && opts.expectVersion !== curV) throw new ConflictError(collection, doc.id);
    const { _v: _ignored, _updatedAt: _ignored2, ...rest } = doc as T & Partial<StoredMeta>;
    const next = { ...structuredClone(rest), _v: curV + 1, _updatedAt: stamp() } as unknown as Stored<T>;
    c.set(doc.id, next as unknown as Stored<Record<string, unknown>>);
    await this.persist(collection);
    return structuredClone(next);
  }
  async list<T>(collection: string, opts?: ListOptions): Promise<Stored<T>[]> {
    const rows = [...this.col(collection).values()].filter((d) => matches(d, opts?.where));
    return sortAndLimit(rows.map((r) => structuredClone(r)), opts) as unknown as Stored<T>[];
  }
  async delete(collection: string, id: string): Promise<void> {
    this.col(collection).delete(id);
    await this.persist(collection);
  }
  protected async persist(_collection: string): Promise<void> {}
}

/** JSON-file store for local development (one file per collection). Not for serverless production. */
export class FileStore extends MemoryStore {
  override readonly kind = "file" as const;
  private loading = new Map<string, Promise<void>>();
  private writing = Promise.resolve();
  constructor(private dir: string) {
    super();
  }
  private file(collection: string) {
    return path.join(this.dir, `${collection.replace(/[^a-z0-9_-]/gi, "_")}.json`);
  }
  private mtimes = new Map<string, number>();

  /**
   * Loads a collection; concurrent callers share one load. If another process
   * (e.g. the worker) changed the file since, it is reloaded, so several
   * processes can share a FileStore during development.
   */
  private async ensure(collection: string): Promise<void> {
    const pending = this.loading.get(collection);
    if (pending) await pending;
    let mtime = 0;
    try {
      mtime = (await fs.stat(this.file(collection))).mtimeMs;
    } catch {
      /* not created yet */
    }
    if (this.loading.has(collection) && this.mtimes.get(collection) === mtime) return;
    const p = (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(this.file(collection), "utf8")) as Stored<Record<string, unknown>>[];
        const c = this.col(collection);
        c.clear();
        for (const d of raw) c.set(String(d.id), d);
      } catch {
        /* new collection */
      }
      this.mtimes.set(collection, mtime);
    })();
    this.loading.set(collection, p);
    await p;
  }
  override async get<T>(collection: string, id: string) {
    await this.ensure(collection);
    return super.get<T>(collection, id);
  }
  override async put<T extends { id: string }>(collection: string, doc: T, opts?: { expectVersion?: number }) {
    await this.ensure(collection);
    return super.put(collection, doc, opts);
  }
  override async list<T>(collection: string, opts?: ListOptions) {
    await this.ensure(collection);
    return super.list<T>(collection, opts);
  }
  override async delete(collection: string, id: string) {
    await this.ensure(collection);
    return super.delete(collection, id);
  }
  protected override async persist(collection: string) {
    const rows = [...this.col(collection).values()];
    this.writing = this.writing.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${this.file(collection)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(rows, null, 1));
      await fs.rename(tmp, this.file(collection));
      this.mtimes.set(collection, (await fs.stat(this.file(collection))).mtimeMs);
    });
    await this.writing;
  }
}

/** Postgres document store: one JSONB table, optimistic versions, containment filters. */
export class PostgresStore implements Store {
  readonly kind = "postgres" as const;
  private ready: Promise<void> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pool: any;
  constructor(private url: string) {}

  private async init() {
    if (!this.ready) {
      this.ready = (async () => {
        const { Pool } = await import("pg");
        this.pool = new Pool({ connectionString: this.url, max: 5, ssl: /localhost|127\.0\.0\.1/.test(this.url) ? undefined : { rejectUnauthorized: false } });
        await this.pool.query(`create table if not exists bingo_docs (
          collection text not null, id text not null, version integer not null,
          data jsonb not null, updated_at timestamptz not null default now(),
          primary key (collection, id))`);
        await this.pool.query(`create index if not exists bingo_docs_updated on bingo_docs (collection, updated_at desc)`);
      })();
    }
    await this.ready;
  }
  private row(r: { data: Record<string, unknown>; version: number; updated_at: Date }) {
    return { ...r.data, _v: r.version, _updatedAt: new Date(r.updated_at).toISOString() };
  }
  async get<T>(collection: string, id: string): Promise<Stored<T> | null> {
    await this.init();
    const r = await this.pool.query(`select data, version, updated_at from bingo_docs where collection=$1 and id=$2`, [collection, id]);
    return r.rows[0] ? (this.row(r.rows[0]) as Stored<T>) : null;
  }
  async put<T extends { id: string }>(collection: string, doc: T, opts?: { expectVersion?: number }): Promise<Stored<T>> {
    await this.init();
    const { _v: _a, _updatedAt: _b, ...data } = doc as T & Partial<StoredMeta>;
    let r;
    if (opts?.expectVersion === 0) {
      r = await this.pool.query(
        `insert into bingo_docs (collection,id,version,data) values ($1,$2,1,$3) on conflict do nothing returning data, version, updated_at`,
        [collection, doc.id, data],
      );
    } else if (opts?.expectVersion !== undefined) {
      r = await this.pool.query(
        `update bingo_docs set data=$3, version=version+1, updated_at=now() where collection=$1 and id=$2 and version=$4 returning data, version, updated_at`,
        [collection, doc.id, data, opts.expectVersion],
      );
    } else {
      r = await this.pool.query(
        `insert into bingo_docs (collection,id,version,data) values ($1,$2,1,$3)
         on conflict (collection,id) do update set data=excluded.data, version=bingo_docs.version+1, updated_at=now()
         returning data, version, updated_at`,
        [collection, doc.id, data],
      );
    }
    if (!r.rows[0]) throw new ConflictError(collection, doc.id);
    return this.row(r.rows[0]) as Stored<T>;
  }
  async list<T>(collection: string, opts?: ListOptions): Promise<Stored<T>[]> {
    await this.init();
    const params: unknown[] = [collection];
    let sql = `select data, version, updated_at from bingo_docs where collection=$1`;
    if (opts?.where && Object.keys(opts.where).length) {
      params.push(JSON.stringify(opts.where));
      sql += ` and data @> $2::jsonb`;
    }
    sql += ` order by updated_at ${opts?.newestFirst === false ? "asc" : "desc"}`;
    if (opts?.limit) sql += ` limit ${Math.floor(opts.limit)}`;
    const r = await this.pool.query(sql, params);
    return r.rows.map((x: never) => this.row(x)) as Stored<T>[];
  }
  async delete(collection: string, id: string): Promise<void> {
    await this.init();
    await this.pool.query(`delete from bingo_docs where collection=$1 and id=$2`, [collection, id]);
  }
}

export function createStoreFromEnv(env: NodeJS.ProcessEnv = process.env): Store {
  if (env.DATABASE_URL) return new PostgresStore(env.DATABASE_URL);
  if (env.VERCEL) {
    // Vercel's filesystem is ephemeral: refuse to pretend data is durable.
    console.warn("[bingo] DATABASE_URL is not set on Vercel — using an in-memory store. Data will NOT persist.");
    return new MemoryStore();
  }
  return new FileStore(env.BINGO_DATA_DIR || path.join(process.cwd(), ".data"));
}

/** Simple lease lock on top of optimistic versions (used by the 24/7 runner). */
export async function tryLease(store: Store, name: string, ttlMs: number, owner: string): Promise<boolean> {
  const id = `lease:${name}`;
  const cur = await store.get<{ id: string; owner: string; until: number }>("locks", id);
  const now = Date.now();
  if (cur && cur.until > now && cur.owner !== owner) return false;
  try {
    await store.put("locks", { id, owner, until: now + ttlMs }, { expectVersion: cur?._v ?? 0 });
    return true;
  } catch (e) {
    if (e instanceof ConflictError) return false;
    throw e;
  }
}

export async function releaseLease(store: Store, name: string, owner: string): Promise<void> {
  const id = `lease:${name}`;
  const cur = await store.get<{ id: string; owner: string; until: number }>("locks", id);
  if (cur && cur.owner === owner) {
    try {
      await store.put("locks", { id, owner, until: 0 }, { expectVersion: cur._v });
    } catch {
      /* someone else took it */
    }
  }
}
