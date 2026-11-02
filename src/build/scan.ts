import type { GeneratedFile } from "./landing";

/**
 * Static security scan of generated code before it is executed or deployed.
 * Blocks: unapproved dependencies, dynamic code execution, process spawning,
 * reading server secrets other than the ones the site is allowed to use,
 * hard-coded credentials, and third-party scripts outside the allow-list.
 */
export interface ScanFinding {
  file: string;
  severity: "block" | "warn";
  rule: string;
  detail: string;
}

export const DEFAULT_ALLOWED_DEPENDENCIES = new Set([
  "next",
  "react",
  "react-dom",
  "typescript",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "@vercel/analytics",
  "@vercel/speed-insights",
  "zod",
  "clsx",
]);

const ALLOWED_ENV = new Set(["BINGO_INTAKE_URL", "LEAD_SIGNING_SECRET", "NODE_ENV"]);
const SCRIPT_HOSTS = ["www.googletagmanager.com", "fonts.googleapis.com", "fonts.gstatic.com"];

const SECRET_PATTERNS: [string, RegExp][] = [
  ["anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai key", /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/],
  ["github token", /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/],
  ["aws key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ["private key", /-----BEGIN (RSA |EC )?PRIVATE KEY-----/],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/],
];

export function scanProject(files: GeneratedFile[], extraAllowedDeps: string[] = []): ScanFinding[] {
  const out: ScanFinding[] = [];
  const allowed = new Set([...DEFAULT_ALLOWED_DEPENDENCIES, ...extraAllowedDeps]);
  for (const f of files) {
    if (Buffer.isBuffer(f.content)) continue;
    const text = f.content;
    if (f.path === "package.json") {
      try {
        const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
        for (const [name, ver] of Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) {
          if (!allowed.has(name)) out.push({ file: f.path, severity: "block", rule: "dependency-allowlist", detail: `${name}@${ver} is not on the approved dependency list` });
          if (/^(git|http|file:|link:)/.test(ver)) out.push({ file: f.path, severity: "block", rule: "dependency-source", detail: `${name} uses a non-registry source (${ver})` });
        }
        for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
          if (/(curl|wget|\bnc\b|bash -c|sh -c|\|\s*sh|rm -rf \/)/.test(cmd)) out.push({ file: f.path, severity: "block", rule: "script", detail: `script "${name}" runs a shell/network command` });
          if (/^(pre|post)?install$/.test(name)) out.push({ file: f.path, severity: "block", rule: "install-script", detail: `install hook "${name}" is not allowed` });
        }
      } catch {
        out.push({ file: f.path, severity: "block", rule: "package-json", detail: "package.json is not valid JSON" });
      }
      continue;
    }
    if (!/\.(m?[jt]sx?|cjs)$/.test(f.path)) {
      for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) out.push({ file: f.path, severity: "block", rule: "secret", detail: `Looks like a hard-coded ${name}` });
      continue;
    }
    for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) out.push({ file: f.path, severity: "block", rule: "secret", detail: `Looks like a hard-coded ${name}` });
    if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) out.push({ file: f.path, severity: "block", rule: "dynamic-code", detail: "eval/new Function is not allowed" });
    if (/(from|require\()\s*["'](node:)?(child_process|cluster|worker_threads|vm)["']/.test(text)) out.push({ file: f.path, severity: "block", rule: "process", detail: "Spawning processes / VMs is not allowed in generated sites" });
    if (/(from|require\()\s*["'](node:)?fs["']/.test(text) && !f.path.startsWith("tests/")) out.push({ file: f.path, severity: "warn", rule: "fs", detail: "File-system access in application code" });
    for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      const name = m[1]!;
      if (!ALLOWED_ENV.has(name) && !name.startsWith("NEXT_PUBLIC_")) out.push({ file: f.path, severity: "block", rule: "env", detail: `Reads server secret process.env.${name}` });
    }
    if (/process\.env\[/.test(text)) out.push({ file: f.path, severity: "block", rule: "env", detail: "Dynamic process.env access" });
    for (const m of text.matchAll(/<script[^>]*src=\{?[`"']https?:\/\/([^/`"']+)/g)) {
      if (!SCRIPT_HOSTS.includes(m[1]!)) out.push({ file: f.path, severity: "block", rule: "third-party-script", detail: `Script from ${m[1]} is not allowed` });
    }
    if (/dangerouslySetInnerHTML/.test(text) && !/__html:\s*(JSON\.stringify|init\b)/.test(text)) out.push({ file: f.path, severity: "warn", rule: "html-injection", detail: "dangerouslySetInnerHTML with non-JSON content" });
  }
  return out;
}
