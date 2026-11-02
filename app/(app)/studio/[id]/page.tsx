import { notFound } from "next/navigation";
import { getCtx } from "@/core/context";
import { FORMATS } from "@/studio/compose";
import { getCreative } from "@/studio/creative";
import { ExportPng, Submit } from "../../../client";
import { studioEdit, studioStatus } from "../../../actions";
import { Ago, Badge, Card, PageHead, Status } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function CreativePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const { id } = await params;
  const { v: vq } = await searchParams;
  const c = await getCreative(getCtx(), id);
  if (!c) notFound();
  const v = c.versions.find((x) => x.v === Number(vq)) ?? c.versions.at(-1)!;
  return (
    <>
      <PageHead
        title={c.concept.name}
        sub={<span className="row"><Status value={c.status} /> <span className="faint">{c.concept.angle} · v{v.v} of {c.versions.length}</span></span>}
        action={
          <div className="row">
            <form action={studioStatus}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="status" value="approved" /><Submit className="btn good" pending="…">Approve</Submit></form>
            <form action={studioStatus}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="status" value="rejected" /><Submit className="btn bad" pending="…">Reject</Submit></form>
          </div>
        }
      />
      {c.notes.length ? <div className="notice" style={{ marginBottom: 14 }}>{c.notes.map((n, i) => <div key={i}>{n}</div>)}</div> : null}
      <div className="grid g2">
        <Card title="Copy & compliance">
          <p><strong>{v.copy.headline}</strong></p>
          <p className="muted">{v.copy.subline}</p>
          <p><Badge>{v.copy.cta}</Badge></p>
          <div className="row"><Status value={v.compliance.status} /> <span className="faint">{v.compliance.matchedClaims.length} approved claim(s) used</span></div>
          {v.compliance.issues.map((i, k) => <p key={k} className="small" style={{ margin: "6px 0 0", color: i.severity === "block" ? "var(--bad)" : "var(--warn)" }}>• {i.reason}: “{i.text}”</p>)}
        </Card>
        <Card title="Edit with words">
          <form action={studioEdit}>
            <input type="hidden" name="id" value={c.id} />
            <textarea name="instruction" placeholder="Make the headline larger, change the background and keep the product bottle unchanged." required />
            <div className="row" style={{ marginTop: 8 }}><Submit pending="Editing…">Apply edit</Submit><span className="faint">The approved packshot is a locked layer — it is never regenerated.</span></div>
          </form>
          <div className="hr" />
          <div className="faint">Versions</div>
          {c.versions.map((x) => <div key={x.v} className="row between small" style={{ padding: "3px 0" }}><a href={`?v=${x.v}`}>v{x.v} — {x.note}</a><Ago iso={x.createdAt} /></div>)}
        </Card>
      </div>
      <div className="section-title"><h2>Formats</h2></div>
      <div className="gallery">
        {v.specs.map((s) => {
          const src = `/api/creatives/${c.id}/svg?format=${s.format}&v=${v.v}`;
          const rd = v.readability.find((r) => r.format === s.format)?.report;
          return (
            <div key={s.format} className="thumb">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`${v.copy.headline} — ${FORMATS[s.format]?.label}`} style={{ aspectRatio: `${s.width} / ${s.height}` }} />
              <div className="meta">
                <div className="row between"><strong className="small">{FORMATS[s.format]?.label}</strong><Badge tone={rd?.ok ? "good" : "warn"}>{rd?.ok ? "readable" : "check"}</Badge></div>
                {rd && !rd.ok ? rd.checks.filter((x) => !x.ok).map((x) => <div key={x.name} className="faint">{x.name}: {x.detail}</div>) : null}
                <div className="row" style={{ marginTop: 6 }}>
                  <a className="btn sm" href={`${src}&download=1`}>SVG</a>
                  <ExportPng src={src} name={`${c.concept.name}-${s.format}`} width={s.width} height={s.height} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
