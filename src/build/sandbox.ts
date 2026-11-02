import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Ctx } from "@/core/context";
import type { GeneratedFile } from "./landing";

/**
 * Restricted execution environment for AI-generated code.
 *
 * Production: Vercel Sandbox (Firecracker microVM) with CPU/time limits, an
 * egress allow-list (npm registry + Google Fonts only), and NO BINGO
 * credentials in its environment.
 * Development: a local child-process sandbox in a throw-away directory with a
 * scrubbed environment and timeouts. It is refused in production because it
 * cannot enforce network isolation.
 */
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface Sandbox {
  kind: "vercel" | "local";
  writeFiles(files: GeneratedFile[]): Promise<void>;
  run(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<RunResult>;
  readFile(p: string): Promise<string | null>;
  stop(): Promise<void>;
}

const ALLOWED_COMMANDS: Record<string, RegExp> = {
  npm: /^(install|ci|run|test)$/,
  node: /^--test$/,
  npx: /^(tsc|next)$/,
};

export const SANDBOX_EGRESS = ["registry.npmjs.org", "*.npmjs.org", "fonts.googleapis.com", "fonts.gstatic.com"];

function assertAllowed(cmd: string, args: string[]) {
  const rule = ALLOWED_COMMANDS[cmd];
  if (!rule || !rule.test(args[0] ?? "")) throw new Error(`Command not allowed in sandbox: ${cmd} ${args.join(" ")}`);
}

const cap = (s: string, n = 120_000) => (s.length > n ? `…(truncated)…\n${s.slice(-n)}` : s);

export class LocalSandbox implements Sandbox {
  kind = "local" as const;
  private constructor(private dir: string) {}
  static async create(): Promise<LocalSandbox> {
    return new LocalSandbox(await mkdtemp(path.join(tmpdir(), "bingo-sbx-")));
  }
  get root() {
    return this.dir;
  }
  private safe(p: string) {
    const full = path.resolve(this.dir, p);
    if (!full.startsWith(this.dir + path.sep)) throw new Error(`Path escapes sandbox: ${p}`);
    return full;
  }
  async writeFiles(files: GeneratedFile[]) {
    for (const f of files) {
      const full = this.safe(f.path);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, f.content);
    }
  }
  async readFile(p: string) {
    try {
      return await readFile(this.safe(p), "utf8");
    } catch {
      return null;
    }
  }
  run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
    assertAllowed(cmd, args);
    const started = Date.now();
    // Scrubbed environment: no BINGO secrets, isolated HOME and npm cache.
    // NODE_ENV is deliberately unset: npm must install devDependencies (TypeScript) for checks.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: this.dir,
      npm_config_cache: path.join(this.dir, ".npm-cache"),
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
      NEXT_TELEMETRY_DISABLED: "1",
      CI: "1",
    };
    for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "npm_config_cafile"]) if (process.env[k]) env[k] = process.env[k]!;
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd: this.dir, env: env as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.on("data", (d) => (stdout = cap(stdout + d)));
      child.stderr.on("data", (d) => (stderr = cap(stderr + d)));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs ?? 300_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr, durationMs: Date.now() - started, timedOut });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ exitCode: 127, stdout, stderr: `${stderr}\n${e.message}`, durationMs: Date.now() - started, timedOut });
      });
    });
  }
  async stop() {
    await rm(this.dir, { recursive: true, force: true });
  }
}

export class VercelSandbox implements Sandbox {
  kind = "vercel" as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(private sbx: any, private cwd: string) {}
  static async create(creds?: { token: string; teamId: string; projectId: string }): Promise<VercelSandbox> {
    const { Sandbox: VS } = await import("@vercel/sandbox");
    const sbx = await VS.create({
      runtime: "node22",
      resources: { vcpus: 2 },
      timeout: 20 * 60_000,
      networkPolicy: { allow: SANDBOX_EGRESS },
      env: { NEXT_TELEMETRY_DISABLED: "1", CI: "1" },
      tags: { app: "bingo-build" },
      ...(creds ?? {}),
    } as never);
    return new VercelSandbox(sbx, `${sbx.cwd ?? "/vercel/sandbox"}/site`);
  }
  async writeFiles(files: GeneratedFile[]) {
    await this.sbx.writeFiles(files.map((f) => ({ path: `${this.cwd}/${f.path}`, content: typeof f.content === "string" ? Buffer.from(f.content) : f.content })));
  }
  async run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
    assertAllowed(cmd, args);
    const started = Date.now();
    const r = await this.sbx.runCommand({ cmd, args, cwd: this.cwd, timeoutMs: opts.timeoutMs ?? 600_000 });
    const [stdout, stderr] = await Promise.all([r.stdout(), r.stderr()]);
    return { exitCode: r.exitCode ?? 1, stdout: cap(stdout), stderr: cap(stderr), durationMs: Date.now() - started, timedOut: false };
  }
  async readFile(p: string) {
    const buf: Buffer | null = await this.sbx.readFileToBuffer({ path: `${this.cwd}/${p}` }).catch(() => null);
    return buf ? buf.toString("utf8") : null;
  }
  async stop() {
    await this.sbx.stop().catch(() => undefined);
  }
}

export type SandboxFactory = (ctx: Ctx) => Promise<Sandbox>;

let factory: SandboxFactory | null = null;
export function setSandboxFactory(f: SandboxFactory | null) {
  factory = f;
}

export async function createSandbox(ctx: Ctx): Promise<Sandbox> {
  if (factory) return factory(ctx);
  const cfg = await ctx.vault.getJson<{ token: string; teamId: string; projectId: string }>("global", "vercel:sandbox");
  if (cfg || process.env.VERCEL_OIDC_TOKEN) return VercelSandbox.create(cfg ?? undefined);
  if (ctx.env.allowLocalSandbox) return LocalSandbox.create();
  throw new Error(
    "No isolated build environment is configured. Connect Vercel Sandbox (Settings → Connections → Vercel → Sandbox project) — BINGO never runs generated code on its own server. For local development only, set BINGO_ALLOW_LOCAL_SANDBOX=1.",
  );
}

/** Standard quality gate: install → typecheck → build → tests. */
export async function runQualityGate(sbx: Sandbox): Promise<{ ok: boolean; steps: { name: string; ok: boolean; output: string; durationMs: number }[] }> {
  const steps: { name: string; ok: boolean; output: string; durationMs: number }[] = [];
  const plan: [string, string, string[], number][] = [
    ["install", "npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], 600_000],
    ["typecheck", "npm", ["run", "typecheck"], 240_000],
    ["build", "npm", ["run", "build"], 600_000],
    ["test", "npm", ["test"], 120_000],
  ];
  for (const [name, cmd, args, timeout] of plan) {
    const r = await sbx.run(cmd, args, { timeoutMs: timeout });
    const ok = r.exitCode === 0 && !r.timedOut;
    steps.push({ name, ok, output: `${r.stdout}\n${r.stderr}`.trim().slice(-8000), durationMs: r.durationMs });
    if (!ok) return { ok: false, steps };
  }
  return { ok: true, steps };
}
