import { notFound } from "next/navigation";
import { getCtx } from "@/core/context";
import { getFiles, getProject } from "@/build/developer";
import { Submit } from "../../../client";
import { buildDomain, buildPublish, buildRollback, buildUpdateCopy } from "../../../actions";
import { Ago, Badge, Card, PageHead, Status } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = getCtx();
  const p = await getProject(ctx, id);
  if (!p) notFound();
  const files = p.revision ? await getFiles(ctx, p.id, p.revision) : [];
  const last = p.checks.at(-1);
  const prods = p.deployments.filter((d) => d.target === "production" && d.state === "READY");
  return (
    <>
      <PageHead
        title={p.name}
        sub={<span className="row"><Status value={p.status} /> <span className="faint">{p.kind} · {p.spec.locales.join(", ")} · revision {p.revision}</span></span>}
        action={p.status === "preview_ready" || p.status === "awaiting_production_approval" ? <form action={buildPublish}><input type="hidden" name="id" value={p.id} /><Submit>Request production publish</Submit></form> : null}
      />
      {p.notes.length ? <div className="notice" style={{ marginBottom: 14 }}>{p.notes.map((n, i) => <div key={i}>{n}</div>)}</div> : null}
      <div className="grid g2">
        <Card title="Where it lives">
          {p.liveUrl ? <p>🌐 Live: <a href={p.liveUrl} target="_blank" rel="noreferrer">{p.liveUrl}</a></p> : <p className="muted">Not live yet.</p>}
          {p.repo ? <p>GitHub: <a href={p.repo.htmlUrl} target="_blank" rel="noreferrer">{p.repo.owner}/{p.repo.name}</a> · branch <code>{p.repo.branch}</code>{p.repo.prUrl ? <> · <a href={p.repo.prUrl} target="_blank" rel="noreferrer">pull request</a></> : null}</p> : <p className="muted">Not on GitHub.</p>}
          {p.vercelProject ? <p>Vercel project: <code>{p.vercelProject.name}</code> {p.vercelProject.createdByBingo ? <Badge tone="info">created by BINGO</Badge> : <Badge tone="warn">existing project</Badge>}</p> : null}
          <p className="faint">Request: {p.request}</p>
        </Card>
        <Card title="Quality gate" action={last ? <Ago iso={last.at} /> : null}>
          {last ? (
            <>
              <div className="row">{last.steps.map((s) => <Badge key={s.name} tone={s.ok ? "good" : "bad"}>{s.name}</Badge>)} <span className="faint">{last.sandbox} sandbox · r{last.revision}</span></div>
              {last.scan.length ? <div style={{ marginTop: 8 }}>{last.scan.map((f, i) => <div key={i} className="small" style={{ color: f.severity === "block" ? "var(--bad)" : "var(--warn)" }}>{f.file}: {f.detail}</div>)}</div> : <p className="faint" style={{ marginTop: 8 }}>Security scan: no findings.</p>}
              {last.steps.filter((s) => !s.ok).map((s) => <pre key={s.name} style={{ marginTop: 8 }}>{s.output}</pre>)}
            </>
          ) : <p className="muted">Not checked yet.</p>}
          {p.repairs.map((r) => <p key={r.revision} className="small">🛠 r{r.revision}: {r.summary.slice(0, 300)}</p>)}
          {p.compliance ? <p className="small" style={{ marginTop: 8 }}>Copy compliance: <Status value={p.compliance.status} /> {p.compliance.issues.slice(0, 5).map((i, k) => <span key={k} className="faint"> · {i.reason}</span>)}</p> : null}
          {p.translationReview.map((t) => <p key={t.locale} className="small" style={{ color: "var(--warn)" }}>Review {t.locale}: {t.reasons.join("; ")}</p>)}
        </Card>
      </div>
      <div className="section-title"><h2>Deployments</h2></div>
      <Card>
        {p.deployments.length ? (
          <table>
            <thead><tr><th>Target</th><th>URL</th><th>State</th><th>Verified</th><th>Rev</th><th /></tr></thead>
            <tbody>
              {[...p.deployments].reverse().map((d) => (
                <tr key={d.id}>
                  <td><Badge tone={d.target === "production" ? "good" : "info"}>{d.target}</Badge></td>
                  <td className="small"><a href={d.url} target="_blank" rel="noreferrer">{d.url}</a></td>
                  <td><Status value={d.state.toLowerCase()} /></td>
                  <td className="small">{d.verified ? (d.verified.ok ? "✓" : d.verified.detail) : "—"}</td>
                  <td>r{d.revision}</td>
                  <td>{d.target === "production" && d.state === "READY" && prods.length > 1 && prods.at(-1)!.id !== d.id ? <form action={buildRollback}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="deploymentId" value={d.id} /><Submit className="btn sm" confirm="Request approval to roll production back to this deployment?">Roll back here</Submit></form> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No deployments yet.</p>}
        {p.vercelProject ? (
          <form action={buildDomain} className="row" style={{ marginTop: 12 }}>
            <input type="hidden" name="id" value={p.id} />
            <input name="domain" placeholder="sleeptime.carpediem.example" style={{ maxWidth: 320 }} required />
            <Submit className="btn">Connect domain (needs approval)</Submit>
          </form>
        ) : null}
      </Card>
      {Object.entries(p.content).map(([locale, c]) => (
        <Card key={locale} title={`Copy — ${locale}`}>
          <form action={buildUpdateCopy}>
            <input type="hidden" name="id" value={p.id} />
            <input type="hidden" name="locale" value={locale} />
            <textarea name="json" defaultValue={JSON.stringify(c, null, 2)} style={{ minHeight: 260, fontFamily: "monospace", fontSize: 12 }} />
            <div className="row" style={{ marginTop: 8 }}><Submit>Save, re-check and rebuild</Submit><span className="faint">Changes run compliance checks again and create a new revision.</span></div>
          </form>
        </Card>
      ))}
      {files.length ? (
        <Card title={`Source (${files.length} files)`}>
          <details><summary>Show file list</summary><pre>{files.map((f) => f.path).join("\n")}</pre></details>
        </Card>
      ) : null}
    </>
  );
}
