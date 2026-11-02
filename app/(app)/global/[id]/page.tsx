import { notFound } from "next/navigation";
import { getCtx } from "@/core/context";
import { STAGES, TERMINAL, countryName, getLead } from "@/global/crm";
import type { OutreachMessage } from "@/global/outreach";
import type { InboundMessage } from "@/global/inbox";
import { isRtl } from "@/lang/detect";
import { Submit } from "../../../client";
import { leadProposeMeeting, leadUpdate } from "../../../actions";
import { Ago, Badge, Card, PageHead, Status } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = getCtx();
  const lead = await getLead(ctx, id);
  if (!lead) notFound();
  const out = await ctx.store.list<OutreachMessage>("outreach", { where: { leadId: id } });
  const inn = await ctx.store.list<InboundMessage>("inbound", { where: { leadId: id } });
  const history = [
    ...out.map((m) => ({ at: m.sentAt ?? m.createdAt, dir: "out" as const, m })),
    ...inn.map((m) => ({ at: m.receivedAt, dir: "in" as const, m })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <>
      <PageHead title={lead.company} sub={<span className="row"><Status value={lead.stage.toLowerCase().replace(/ /g, "_")} /> <span className="faint">{countryName(lead.country)} · {lead.city} · fit {lead.relevance}/100</span></span>} />
      <div className="grid g2">
        <Card title="Company">
          <p>{lead.website ? <a href={lead.website} target="_blank" rel="noreferrer">{lead.website}</a> : "No website"}</p>
          <p className="muted">{lead.description}</p>
          <p className="small">{lead.portfolioFit}</p>
          <div className="faint">Verification</div>
          {lead.verification.checks.map((c) => <div key={c.name} className="small">{c.ok ? "✓" : "✗"} {c.name} — {c.detail}</div>)}
          <div className="faint" style={{ marginTop: 8 }}>Emails</div>
          {lead.emails.map((e) => <div key={e.address} className="small">{e.address} {e.verified ? <Badge tone="good">verified</Badge> : <Badge tone="warn">unverified</Badge>} <span className="faint">{e.note}</span></div>)}
          <div className="faint" style={{ marginTop: 8 }}>Sources</div>
          {lead.sources.map((s) => <div key={s.url} className="small"><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a></div>)}
        </Card>
        <Card title="Update">
          <form action={leadUpdate}>
            <input type="hidden" name="id" value={lead.id} />
            <div className="grid g2">
              <div className="field"><label>Stage</label><select name="stage" defaultValue={lead.stage}>{[...STAGES, ...TERMINAL].map((s) => <option key={s}>{s}</option>)}</select></div>
              <div className="field"><label>Preferred language</label><input name="language" defaultValue={lead.language ?? ""} placeholder="ru, uz, en…" /></div>
              <div className="field"><label>Owner</label><input name="owner" defaultValue={lead.owner} /></div>
              <div className="field"><label>Add verified email</label><input name="email" type="email" /></div>
            </div>
            <div className="field"><label>Notes</label><textarea name="notes" defaultValue={lead.notes} /></div>
            <Submit>Save</Submit>
          </form>
          <div className="hr" />
          <form action={leadProposeMeeting} className="row">
            <input type="hidden" name="id" value={lead.id} />
            <input name="objective" placeholder="Meeting objective" style={{ maxWidth: 280 }} />
            <input name="duration" type="number" defaultValue={30} style={{ width: 80 }} aria-label="Minutes" />
            <Submit className="btn">Propose meeting times</Submit>
          </form>
          {lead.optedOut ? <p className="notice bad" style={{ marginTop: 10 }}>Opted out — BINGO will not contact this company.</p> : null}
        </Card>
      </div>
      <div className="section-title"><h2>Communication history</h2></div>
      <div className="stack">
        {history.map((h) => (
          <Card key={h.m.id} title={<span className="row">{h.dir === "out" ? <Badge tone="info">sent</Badge> : <Badge tone="live">received</Badge>} {h.dir === "out" ? (h.m as OutreachMessage).subject : (h.m as InboundMessage).subject} {h.dir === "out" ? <Status value={(h.m as OutreachMessage).status} /> : <Badge>{(h.m as InboundMessage).intent}</Badge>}</span>} action={<Ago iso={h.at} />}>
            {h.dir === "out" ? (
              <>
                <pre dir={isRtl((h.m as OutreachMessage).language) ? "rtl" : "ltr"}>{(h.m as OutreachMessage).body}</pre>
                {(h.m as OutreachMessage).gmail ? <p className="faint">Gmail message {(h.m as OutreachMessage).gmail!.id} · thread {(h.m as OutreachMessage).gmail!.threadId}</p> : null}
              </>
            ) : (
              <div className="grid g2">
                <pre dir={isRtl((h.m as InboundMessage).language) ? "rtl" : "ltr"}>{(h.m as InboundMessage).original.slice(0, 3000)}</pre>
                <div>
                  <p className="small">{(h.m as InboundMessage).summary}</p>
                  {(h.m as InboundMessage).translation ? <pre>{(h.m as InboundMessage).translation}</pre> : null}
                  {(h.m as InboundMessage).suspicious ? <p className="small" style={{ color: "var(--bad)" }}>⚠ Contains instruction-like text (possible prompt injection). Treated as data only.</p> : null}
                  {(h.m as InboundMessage).actions.map((a) => <div key={a} className="faint">→ {a}</div>)}
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
