import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { Store } from "./store";

/**
 * Server-side secret storage. Credentials are encrypted with AES-256-GCM using
 * BINGO_MASTER_KEY and never returned to the browser — the UI only sees a
 * masked hint. Revoking a credential deletes the ciphertext.
 */
export interface SecretRecord {
  id: string; // e.g. "global:anthropic" or "ws_carpediem:google"
  scope: string;
  name: string;
  hint: string;
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
  rotatedAt?: string;
  meta?: Record<string, string>;
}

export interface SecretInfo {
  id: string;
  scope: string;
  name: string;
  hint: string;
  createdAt: string;
  rotatedAt?: string;
  meta?: Record<string, string>;
}

function deriveKey(master: string): Buffer {
  const trimmed = master.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  const b64 = Buffer.from(trimmed, "base64");
  if (b64.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(trimmed)) return b64;
  return scryptSync(trimmed, "bingo-vault-v1", 32);
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

export class Vault {
  private key: Buffer;
  constructor(
    private store: Store,
    masterKey: string,
  ) {
    if (!masterKey || masterKey.length < 16) throw new Error("BINGO_MASTER_KEY must be set (at least 16 characters, ideally 32 random bytes as hex).");
    this.key = deriveKey(masterKey);
  }

  static id(scope: string, name: string) {
    return `${scope}:${name}`;
  }

  async set(scope: string, name: string, value: string, meta?: Record<string, string>): Promise<SecretInfo> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(Vault.id(scope, name)));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const existing = await this.store.get<SecretRecord>("secrets", Vault.id(scope, name));
    const rec: SecretRecord = {
      id: Vault.id(scope, name),
      scope,
      name,
      hint: maskSecret(value),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      rotatedAt: existing ? new Date().toISOString() : undefined,
      meta,
    };
    await this.store.put("secrets", rec);
    return Vault.info(rec);
  }

  async get(scope: string, name: string): Promise<string | null> {
    const rec = await this.store.get<SecretRecord>("secrets", Vault.id(scope, name));
    if (!rec) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(rec.iv, "base64"));
    decipher.setAAD(Buffer.from(rec.id));
    decipher.setAuthTag(Buffer.from(rec.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(rec.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  /** Looks in the workspace scope first, then global. */
  async resolve(name: string, workspaceId?: string): Promise<string | null> {
    if (workspaceId) {
      const v = await this.get(workspaceId, name);
      if (v) return v;
    }
    return this.get("global", name);
  }

  async getJson<T>(scope: string, name: string): Promise<T | null> {
    const v = await this.get(scope, name);
    return v ? (JSON.parse(v) as T) : null;
  }

  async setJson(scope: string, name: string, value: unknown, meta?: Record<string, string>) {
    const json = JSON.stringify(value);
    const info = await this.set(scope, name, json, meta);
    return { ...info, hint: "•••• (structured credential)" };
  }

  async revoke(scope: string, name: string): Promise<void> {
    await this.store.delete("secrets", Vault.id(scope, name));
  }

  async list(): Promise<SecretInfo[]> {
    const rows = await this.store.list<SecretRecord>("secrets");
    return rows.map(Vault.info);
  }

  static info(r: SecretRecord): SecretInfo {
    return { id: r.id, scope: r.scope, name: r.name, hint: r.hint, createdAt: r.createdAt, rotatedAt: r.rotatedAt, meta: r.meta };
  }
}
