import Link from "next/link";
import type { ReactNode } from "react";

export function Badge({ tone, children }: { tone?: "good" | "warn" | "bad" | "info" | "live"; children: ReactNode }) {
  return <span className={`badge ${tone ?? ""}`}>{children}</span>;
}

const TONES: Record<string, "good" | "warn" | "bad" | "info" | "live"> = {
  done: "good", completed: "good", approved: "good", sent: "good", live: "good", confirmed: "good", pass: "good", verified: "good", ok: "good", acknowledged: "good", resolved: "good", active: "good", invited: "info", preview_ready: "info",
  running: "live", waiting: "live", pending: "info", in_review: "info", draft: "info", awaiting_reply: "info", proposed: "info", time_agreed: "info", consumed: "good",
  waiting_approval: "warn", awaiting_approval: "warn", blocked: "warn", needs_review: "warn", needs_attention: "warn", needs_changes: "warn", paused: "warn", open: "warn", unverified: "warn", checks_failed: "bad",
  failed: "bad", rejected: "bad", cancelled: "bad", suppressed: "bad", declined: "bad", error: "bad",
};

export function Status({ value }: { value: string }) {
  return <Badge tone={TONES[value]}>{value.replace(/_/g, " ")}</Badge>;
}

export function Ago({ iso }: { iso?: string | null }) {
  if (!iso) return <span className="faint">—</span>;
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const t = Math.abs(s) < 60 ? `${Math.abs(s)}s` : Math.abs(s) < 3600 ? `${Math.round(Math.abs(s) / 60)}m` : Math.abs(s) < 86400 ? `${Math.round(Math.abs(s) / 3600)}h` : `${Math.round(Math.abs(s) / 86400)}d`;
  return <time dateTime={iso} title={new Date(iso).toLocaleString()} className="faint">{s >= 0 ? `${t} ago` : `in ${t}`}</time>;
}

export function Card({ title, action, children, id }: { title?: ReactNode; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      {title || action ? (
        <div className="row between" style={{ marginBottom: 12 }}>
          {title ? <h2 style={{ margin: 0 }}>{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted small" style={{ margin: 0 }}>{children}</p>;
}

export function PageHead({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="row between" style={{ marginBottom: 18, alignItems: "flex-end" }}>
      <div>
        <h1>{title}</h1>
        {sub ? <p className="muted" style={{ margin: 0 }}>{sub}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function NavLink({ href, label, sub, active }: { href: string; label: string; sub?: string; active: boolean }) {
  return (
    <Link href={href} className={active ? "on" : ""}>
      <span>
        {label}
        {sub ? <span className="sub">{sub}</span> : null}
      </span>
    </Link>
  );
}

export function Money({ usd }: { usd: number }) {
  return <span>${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}</span>;
}
