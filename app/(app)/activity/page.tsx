import Link from "next/link";
import { getCtx, recentActivity } from "@/core/context";
import { listWorkflows } from "@/orchestrator/workflow";
import { jobStatus } from "@/orchestrator/scheduler";
import { AutoRefresh, Submit } from "../../client";
import { runNow } from "../../actions";
import { Ago, Card, PageHead, Status } from "../../ui";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const ctx = getCtx();
  const [activity, workflows, jobs] = await Promise.all([recentActivity(ctx, 200), listWorkflows(ctx, 100), jobStatus(ctx)]);
  return (
    <>
      <AutoRefresh ms={10000} />
      <PageHead title="Activity" sub="Everything BINGO did, with real outcomes — including what happened while you were away." action={<form action={runNow}><Submit className="btn">Run scheduler now</Submit></form>} />
      <div className="grid g2">
        <Card title="24/7 scheduler" action={<span className="faint">heartbeat <Ago iso={jobs.heartbeat} /></span>}>
          {jobs.jobs.length ? (
            <table><tbody>{jobs.jobs.map((j) => <tr key={j.id}><td>{j.id}</td><td><Status value={j.ok ? "ok" : "error"} /></td><td className="small">{j.lastResult}</td><td><Ago iso={j.lastRunAt} /></td></tr>)}</tbody></table>
          ) : <p className="muted small">The scheduler has not run yet. On Vercel it runs from Vercel Cron (set CRON_SECRET). Elsewhere run <code>npm run worker</code>.</p>}
        </Card>
        <Card title="Workflows">
          <table><tbody>{workflows.map((w) => <tr key={w.id}><td><Link href={`/workflows/${w.id}`}>{w.goal.slice(0, 70)}</Link></td><td><Status value={w.status} /></td><td><Ago iso={w.updatedAt} /></td></tr>)}</tbody></table>
        </Card>
      </div>
      <Card title="Log">
        <table>
          <tbody>
            {activity.map((a) => (
              <tr key={a.id}>
                <td style={{ width: 120 }}><Ago iso={a.at} /></td>
                <td style={{ width: 150 }} className="faint">{a.actor}</td>
                <td><span className={`dot ${a.level === "error" ? "bad" : a.level === "warning" || a.level === "approval" ? "warn" : a.level === "success" ? "good" : ""}`} /> {a.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
