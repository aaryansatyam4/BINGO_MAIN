import Link from "next/link";
import { getCtx, recentActivity } from "@/core/context";
import { listApprovals, isSuspended } from "@/core/policy";
import { getOwner } from "@/core/settings";
import { listWorkflows } from "@/orchestrator/workflow";
import { listLeads } from "@/global/crm";
import { listProjects } from "@/build/developer";
import { listCreatives } from "@/studio/creative";
import { connectionHealth } from "@/web/health";
import { AskBox, AutoRefresh, Submit } from "../client";
import { decideApprovalAction, emergencyStop } from "../actions";
import { Ago, Badge, Card, Empty, Status } from "../ui";

export const dynamic = "force-dynamic";

export default async function Home() {
  const ctx = getCtx();
  const [owner, approvals, workflows, activity, health, leads, projects, creatives, stopped, incidents] = await Promise.all([
    getOwner(ctx),
    listApprovals(ctx),
    listWorkflows(ctx, 30),
    recentActivity(ctx, 14),
    connectionHealth(ctx),
    listLeads(ctx),
    listProjects(ctx),
    listCreatives(ctx),
    isSuspended(ctx),
    ctx.store.list<{ id: string; status: string; severity: string; title: string }>("incidents", { where: { status: "open" } }),
  ]);
  const active = workflows.filter((w) => ["running", "needs_attention", "paused"].includes(w.status));
  const done = workflows.filter((w) => ["completed", "failed", "cancelled"].includes(w.status)).slice(0, 6);
  return (
    <>
      <AutoRefresh ms={8000} />
      <div style={{ margin: "8px 0 26px" }}>
        <h1 style={{ fontSize: "2.1rem" }}>Good to see you{owner.name && owner.name !== "Owner" ? `, ${owner.name.split(" ")[0]}` : ""}.</h1>
        <p className="muted">Give BINGO an objective. It plans across research, design, code, outreach, meetings and reports — and asks you before anything important happens.</p>
        <AskBox big />
      </div>

      <div className="grid g4">
        <div className="card"><div className="faint">Waiting for you</div><div className="kpi">{approvals.length + incidents.length}</div></div>
        <div className="card"><div className="faint">Active workflows</div><div className="kpi">{active.length}</div></div>
        <div className="card"><div className="faint">Distributor leads</div><div className="kpi">{leads.length}</div><div className="faint">{leads.filter((l) => l.stage === "Meeting Confirmed").length} meetings confirmed</div></div>
        <div className="card"><div className="faint">Live sites · creatives in review</div><div className="kpi">{projects.filter((p) => p.status === "live").length} · {creatives.filter((c) => c.status === "in_review").length}</div></div>
      </div>

      <div className="section-title"><h2>Needs your decision</h2><span className="faint">BINGO never sends, publishes or commits without this</span></div>
      <div className="stack">
        {incidents.map((i) => (
          <div key={i.id} className="card row between">
            <div><Badge tone={i.severity === "CRITICAL" ? "bad" : "warn"}>{i.severity}</Badge> <strong>{i.title}</strong></div>
            <Link className="btn sm" href={`/speak#${i.id}`}>Review</Link>
          </div>
        ))}
        {approvals.length ? approvals.map((a) => (
          <div key={a.id} className="card">
            <div className="row between">
              <div className="row"><Badge tone="warn">{a.kind}</Badge><strong>{a.title}</strong></div>
              <Ago iso={a.requestedAt} />
            </div>
            <pre style={{ marginTop: 10 }}>{a.summary}</pre>
            <form action={decideApprovalAction} className="row" style={{ marginTop: 10 }}>
              <input type="hidden" name="id" value={a.id} />
              <input name="note" placeholder="Optional note" style={{ maxWidth: 320 }} />
              <Submit className="btn good" name="decision" value="approve" pending="Approving…">Approve</Submit>
              <Submit className="btn bad" name="decision" value="reject" pending="…">Reject</Submit>
              {a.workflowId ? <Link className="btn sm" href={`/workflows/${a.workflowId}`}>View plan</Link> : null}
            </form>
          </div>
        )) : incidents.length ? null : <Card><Empty>Nothing needs you right now.</Empty></Card>}
      </div>

      <div className="grid g2" style={{ marginTop: 26 }}>
        <Card title="In progress" action={<Link href="/activity" className="small">History →</Link>}>
          {active.length ? (
            <table>
              <tbody>
                {active.map((w) => {
                  const doneN = w.steps.filter((s) => s.status === "done").length;
                  return (
                    <tr key={w.id}>
                      <td><Link href={`/workflows/${w.id}`}>{w.goal.slice(0, 90)}</Link><div className="faint">{doneN}/{w.steps.length} steps · <Ago iso={w.updatedAt} /></div></td>
                      <td style={{ textAlign: "right" }}><Status value={w.steps.some((s) => s.status === "waiting_approval") ? "waiting_approval" : w.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <Empty>No active workflows.</Empty>}
          {done.length ? (
            <>
              <div className="hr" />
              <div className="faint" style={{ marginBottom: 6 }}>Recently finished</div>
              {done.map((w) => <div key={w.id} className="row between small" style={{ padding: "4px 0" }}><Link href={`/workflows/${w.id}`}>{w.goal.slice(0, 70)}</Link><Status value={w.status} /></div>)}
            </>
          ) : null}
        </Card>
        <Card title="Connections" action={<Link href="/settings" className="small">Settings →</Link>}>
          {health.map((h) => (
            <div key={h.key} className="row between" style={{ padding: "5px 0" }}>
              <div className="row"><span className={`dot ${h.ok ? "good" : "warn"}`} /> {h.label}</div>
              <Link href={h.href} className="faint">{h.detail}</Link>
            </div>
          ))}
        </Card>
      </div>

      <div className="grid g2" style={{ marginTop: 14 }}>
        <Card title="Latest activity">
          {activity.length ? activity.map((a) => (
            <div key={a.id} className="row between small" style={{ padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
              <span><span className={`dot ${a.level === "error" ? "bad" : a.level === "warning" || a.level === "approval" ? "warn" : a.level === "success" ? "good" : ""}`} /> {a.summary}</span>
              <Ago iso={a.at} />
            </div>
          )) : <Empty>Nothing yet.</Empty>}
        </Card>
        <Card title="Emergency stop">
          <p className="muted small">Instantly suspends every automation, scheduled job and pending send. Approvals and data are kept.</p>
          <form action={emergencyStop} className="row">
            <input type="hidden" name="on" value={stopped ? "0" : "1"} />
            {stopped ? <Submit className="btn good">Resume automations</Submit> : <><input name="reason" placeholder="Reason (optional)" style={{ maxWidth: 260 }} /><Submit className="btn bad" confirm="Stop all automations now?">Stop everything</Submit></>}
          </form>
        </Card>
      </div>
    </>
  );
}
