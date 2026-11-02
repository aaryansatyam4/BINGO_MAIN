import { Nav } from "../nav";
import { TopAsk } from "../client";
import { authMode } from "@/web/session";
import { getCtx } from "@/core/context";
import { isSuspended } from "@/core/policy";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = getCtx();
  const suspended = await isSuspended(ctx).catch(() => null);
  const mode = authMode();
  return (
        <div className="shell">
          <aside className="side">
            <div className="brand">
              <span className="orb" aria-hidden="true" />
              BINGO
            </div>
            <Nav />
            <div className="foot">
              <div>Store: {ctx.store.kind}</div>
              {mode === "open-dev" ? <div style={{ color: "var(--warn)" }}>Dev mode: no password</div> : null}
            </div>
          </aside>
          <main className="main">
            {suspended ? <p className="notice bad" style={{ marginBottom: 14 }}>⛔ Emergency stop is active — all automations are paused. ({suspended.reason})</p> : null}
            {ctx.store.kind === "memory" ? <p className="notice bad" style={{ marginBottom: 14 }}>No DATABASE_URL: data is held in memory and will be lost. Add a Postgres database in Vercel.</p> : null}
            <TopAsk />
            {children}
          </main>
        </div>
  );
}
