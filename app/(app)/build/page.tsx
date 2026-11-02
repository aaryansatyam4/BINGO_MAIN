import Link from "next/link";
import { getCtx } from "@/core/context";
import { listProjects } from "@/build/developer";
import { AskBox } from "../../client";
import { Ago, Card, Empty, PageHead, Status } from "../../ui";

export const dynamic = "force-dynamic";

export default async function BuildPage() {
  const projects = await listProjects(getCtx());
  return (
    <>
      <PageHead title="BINGO Build" sub="Websites, landing pages and tools — generated, tested in an isolated sandbox, versioned on GitHub, previewed on Vercel, published only with your approval." />
      <Card title="New project">
        <p className="muted small">Describe it in plain words, e.g. “Make a landing page to find distributors in Nepal”, “Create a multilingual export website in Russian and English”, “Build a premium HappyGut 140B landing page and deploy it to Vercel”.</p>
        <AskBox />
      </Card>
      <div className="section-title"><h2>Projects</h2></div>
      <Card>
        {projects.length ? (
          <table>
            <thead><tr><th>Project</th><th>Locales</th><th>Checks</th><th>Preview / live</th><th>Status</th></tr></thead>
            <tbody>
              {projects.map((p) => {
                const last = p.checks.at(-1);
                const preview = [...p.deployments].reverse().find((d) => d.target === "preview");
                return (
                  <tr key={p.id}>
                    <td><Link href={`/build/${p.id}`}>{p.name}</Link><div className="faint">r{p.revision} · <Ago iso={p.updatedAt} /></div></td>
                    <td>{p.spec.locales.join(", ")}</td>
                    <td>{last ? <Status value={last.ok ? "pass" : "failed"} /> : <span className="faint">—</span>}</td>
                    <td className="small">{p.liveUrl ? <a href={p.liveUrl} target="_blank" rel="noreferrer">{p.liveUrl}</a> : preview ? <a href={preview.url} target="_blank" rel="noreferrer">{preview.url}</a> : "—"}</td>
                    <td><Status value={p.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <Empty>No projects yet.</Empty>}
      </Card>
    </>
  );
}
