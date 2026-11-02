import Link from "next/link";
import { notFound } from "next/navigation";
import { getCtx } from "@/core/context";
import type { Approval } from "@/core/policy";
import { getWorkflow } from "@/orchestrator/workflow";
import { AutoRefresh, Submit } from "../../../client";
import { decideApprovalAction, runNow, stepControl, workflowControl } from "../../../actions";
import { Ago, Badge, Card, Money, PageHead, Status } from "../../../ui";

export const dynamic = "force-dynamic";

function Link2({ value }: { value: unknown }) {
  const s = String(value ?? "");
  return /^https?:\/\//.test(s) ? <a href={s} target="_blank" rel="noreferrer">{s}</a> : <>{s}</>;
}

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = getCtx();
  const wf = await getWorkflow(ctx, id);
  if (!wf) notFound();
  const approvals = new Map<string, Approval>();
  for (const s of wf.steps) if (s.approvalId) {
    const a = await ctx.store.get<Approval>("approvals", s.approvalId);
    if (a) approvals.set(s.approvalId, a);
  }
  const usd = wf.steps.reduce((a, s) => a + s.usage.aiUsd, 0);
  const calls = wf.steps.reduce((a, s) => a + s.usage.aiCalls, 0);
  const live = ["running", "needs_attention"].includes(wf.status);
  const links = wf.steps.flatMap((s) => Object.entries(s.result ?? {}).filter(([, v]) => typeof v === "string" && /^https?:\/\//.test(v as string)).map(([k, v]) => ({ k, v: v as string })));
  return (
    <>
      {live ? <AutoRefresh ms={3500} /> : null}
      <PageHead
        title={wf.goal.length > 90 ? `${wf.goal.slice(0, 88)}…` : wf.goal}
        sub={<span className="row"><Status value={wf.status} /> <span className="faint">started <Ago iso={wf.createdAt} /> · {wf.source.kind}{wf.source.kind === "skill" ? ` (${wf.source.id})` : ""}</span></span>}
        action={
          <div className="row">
            {wf.status === "paused" ? <form action={workflowControl}><input type="hidden" name="id" value={wf.id} /><input type="hidden" name="action" value="resume" /><Submit className="btn good">Resume</Submit></form> : null}
            {live ? <form action={workflowControl}><input type="hidden" name="id" value={wf.id} /><input type="hidden" name="action" value="pause" /><Submit className="btn">Pause</Submit></form> : null}
            {!["completed", "failed", "cancelled"].includes(wf.status) ? <form action={workflowControl}><input type="hidden" name="id" value={wf.id} /><input type="hidden" name="action" value="cancel" /><Submit className="btn bad" confirm="Cancel this workflow? Pending steps will not run.">Cancel</Submit></form> : null}
            {live ? <form action={runNow}><Submit className="btn">Run now</Submit></form> : null}
          </div>
        }
      />
      {wf.appliedSkills.length || wf.notes.length ? (
        <div className="notice" style={{ marginBottom: 14 }}>
          {wf.appliedSkills.map((s) => <div key={s.id}>🧠 Applied skill: {s.name} (v{s.version})</div>)}
          {wf.notes.map((n, i) => <div key={i}>{n}</div>)}
        </div>
      ) : null}
      {links.length ? (
        <Card title="Results">
          {links.map((l) => <div key={l.k + l.v} className="row"><Badge tone="good">{l.k}</Badge> <Link2 value={l.v} /></div>)}
        </Card>
      ) : null}
      <Card title="Execution plan" action={<span className="faint">{calls} AI calls · <Money usd={usd} /> · {Math.round(wf.steps.reduce((a, s) => a + s.usage.ms, 0) / 1000)}s compute</span>}>
        <div className="steps">
          {wf.steps.map((s, i) => {
            const a = s.approvalId ? approvals.get(s.approvalId) : undefined;
            return (
              <div key={s.id} className={`step ${s.status}`}>
                <div className="ix">{s.status === "done" ? "✓" : s.status === "failed" ? "!" : i + 1}</div>
                <div>
                  <div className="row"><strong>{s.title}</strong> <Status value={s.status} />{s.deps.length ? <span className="faint">after {s.deps.join(", ")}</span> : null}</div>
                  {s.summary ? <p className="small" style={{ margin: "6px 0 0" }}>{s.summary}</p> : null}
                  {s.error ? <p className="small" style={{ margin: "6px 0 0", color: "var(--bad)" }}>{s.error}</p> : null}
                  {s.status === "waiting" && s.resumeAt ? <div className="faint">next check <Ago iso={s.resumeAt} /></div> : null}
                  {a && a.status === "pending" ? (
                    <form action={decideApprovalAction} className="card" style={{ marginTop: 10, padding: 12 }}>
                      <input type="hidden" name="id" value={a.id} />
                      <div className="row"><Badge tone="warn">approval</Badge> <strong>{a.title}</strong></div>
                      <pre style={{ margin: "8px 0" }}>{a.summary}</pre>
                      <div className="row">
                        <input name="note" placeholder="Note (optional)" style={{ maxWidth: 300 }} />
                        <Submit className="btn good" name="decision" value="approve">Approve</Submit>
                        <Submit className="btn bad" name="decision" value="reject">Reject</Submit>
                      </div>
                    </form>
                  ) : null}
                  {s.usage.aiCalls ? <div className="faint">{s.usage.models.join(", ")} · <Money usd={s.usage.aiUsd} /></div> : null}
                  {["pending", "blocked", "failed"].includes(s.status) ? (
                    <details style={{ marginTop: 6 }}>
                      <summary className="small">Modify</summary>
                      <form action={stepControl} style={{ marginTop: 8 }}>
                        <input type="hidden" name="id" value={wf.id} />
                        <input type="hidden" name="step" value={s.id} />
                        <textarea name="params" defaultValue={JSON.stringify(s.params, null, 2)} style={{ fontFamily: "monospace", fontSize: 12 }} />
                        <div className="row" style={{ marginTop: 6 }}>
                          <Submit className="btn sm" name="action" value="params">Save parameters</Submit>
                        </div>
                      </form>
                    </details>
                  ) : null}
                </div>
                <div className="row" style={{ alignItems: "flex-start" }}>
                  {["failed", "blocked"].includes(s.status) ? <form action={stepControl}><input type="hidden" name="id" value={wf.id} /><input type="hidden" name="step" value={s.id} /><Submit className="btn sm" name="action" value="retry">Retry</Submit></form> : null}
                  {["pending", "blocked", "waiting", "waiting_approval"].includes(s.status) ? <form action={stepControl}><input type="hidden" name="id" value={wf.id} /><input type="hidden" name="step" value={s.id} /><Submit className="btn sm" name="action" value="skip" confirm="Skip this step and everything that depends on it?">Skip</Submit></form> : null}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}
