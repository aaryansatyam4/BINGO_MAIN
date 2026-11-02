import Link from "next/link";
import { getCtx } from "@/core/context";
import { STAGES, TERMINAL, countryName, listLeads } from "@/global/crm";
import { listOutreach } from "@/global/outreach";
import { listMeetings } from "@/calendar/meetings";
import { formatInZone } from "@/calendar/tz";
import { getOwner } from "@/core/settings";
import { isRtl } from "@/lang/detect";
import { AskBox, Submit } from "../../client";
import { globalEditDraft, globalSendSelected, meetingBrief, meetingInvite } from "../../actions";
import { Badge, Card, Empty, PageHead, Status } from "../../ui";

export const dynamic = "force-dynamic";

export default async function GlobalPage({ searchParams }: { searchParams: Promise<{ country?: string; stage?: string }> }) {
  const q = await searchParams;
  const ctx = getCtx();
  const [leads, drafts, meetings, owner] = await Promise.all([listLeads(ctx), listOutreach(ctx), listMeetings(ctx), getOwner(ctx)]);
  const shown = leads.filter((l) => (!q.country || l.country === q.country) && (!q.stage || l.stage === q.stage));
  const countries = [...new Set(leads.map((l) => l.country))];
  const pending = drafts.filter((d) => ["draft", "awaiting_approval", "blocked"].includes(d.status));
  const leadName = new Map(leads.map((l) => [l.id, l.company]));
  return (
    <>
      <PageHead title="BINGO Global" sub="Verified distributor research, multilingual outreach, replies, meetings and pipeline — one place." />
      <Card>
        <p className="muted small">Try: “Find 30 pharmaceutical distributors in Uzbekistan and prepare our outreach in Russian” · “Arrange meetings next week with the distributors who responded positively”.</p>
        <AskBox />
      </Card>

      <div className="section-title"><h2>Pipeline</h2><span className="faint">{leads.length} leads · edits in the Google Sheet sync back every 30 min</span></div>
      <div className="row" style={{ marginBottom: 10 }}>
        <Link className="btn sm" href="/global">All</Link>
        {countries.map((c) => <Link key={c} className="btn sm" href={`/global?country=${c}`}>{countryName(c)}</Link>)}
      </div>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${Math.min(6, STAGES.length)}, minmax(0,1fr))`, marginBottom: 14 }}>
        {[...STAGES, ...TERMINAL].map((s) => {
          const n = leads.filter((l) => l.stage === s && (!q.country || l.country === q.country)).length;
          return n ? <Link key={s} href={`/global?stage=${encodeURIComponent(s)}${q.country ? `&country=${q.country}` : ""}`} className="card" style={{ padding: 12, textDecoration: "none", color: "inherit" }}><div className="faint">{s}</div><div className="kpi" style={{ fontSize: "1.3rem" }}>{n}</div></Link> : null;
        })}
      </div>
      <Card>
        {shown.length ? (
          <table>
            <thead><tr><th>Company</th><th>Country</th><th>Contact</th><th>Lang</th><th>Fit</th><th>Verification</th><th>Stage</th></tr></thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id}>
                  <td><Link href={`/global/${l.id}`}>{l.company}</Link><div className="faint">{l.city}</div></td>
                  <td>{countryName(l.country)}</td>
                  <td className="small">{l.emails[0]?.address ?? "—"} {l.emails[0]?.verified ? <Badge tone="good">on site</Badge> : null}</td>
                  <td>{l.language ?? "—"}</td>
                  <td>{l.relevance || "—"}</td>
                  <td><Status value={l.verification.status} /></td>
                  <td><Status value={l.stage.toLowerCase().replace(/ /g, "_")} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>No leads yet.</Empty>}
      </Card>

      <div className="section-title"><h2>Emails awaiting review</h2><span className="faint">Original + your-language translation. Any edit needs approval again.</span></div>
      {pending.length ? (
        <form action={globalSendSelected} id="send-form" />
      ) : null}
      <div className="stack">
        {pending.length ? pending.map((m) => (
          <Card key={m.id} title={<span className="row"><input type="checkbox" name="ids" value={m.id} form="send-form" defaultChecked={m.status === "draft"} aria-label="Select" /> {leadName.get(m.leadId) ?? m.to} <Badge>{m.language}</Badge> <Badge tone="info">{m.kind}</Badge> <Status value={m.status} /></span>}>
            <div className="grid g2">
              <form action={globalEditDraft}>
                <input type="hidden" name="id" value={m.id} />
                <div className="field"><label>To</label><input name="to" defaultValue={m.to} /></div>
                <div className="field"><label>Subject</label><input name="subject" defaultValue={m.subject} /></div>
                <div className="field"><label>Body ({m.language})</label><textarea name="body" defaultValue={m.body} className={isRtl(m.language) ? "rtl" : ""} dir={isRtl(m.language) ? "rtl" : "ltr"} style={{ minHeight: 180 }} /></div>
                <Submit className="btn sm">Save edit</Submit>
              </form>
              <div>
                <label>Translation for you ({owner.preferredLanguage})</label>
                <pre style={{ minHeight: 180 }}>{m.forOwner?.translated || "Same language — no translation needed."}</pre>
                {m.forOwner?.needsReview ? <p className="small" style={{ color: "var(--warn)" }}>⚠ {m.forOwner.reviewReasons.join("; ")}</p> : null}
                {m.compliance.issues.map((i, k) => <p key={k} className="small" style={{ margin: "4px 0", color: i.severity === "block" ? "var(--bad)" : "var(--warn)" }}>• {i.reason}: “{i.text}”</p>)}
              </div>
            </div>
          </Card>
        )) : <Card><Empty>No drafts waiting.</Empty></Card>}
        {pending.length ? <div className="row"><button className="btn primary" type="submit" form="send-form">Request approval to send selected</button><span className="faint">Approval appears on Home and Telegram. Sending respects daily/per-domain limits and opt-outs.</span></div> : null}
      </div>

      <div className="section-title"><h2>Meetings & interviews</h2><span className="faint">Google Calendar is the source of truth</span></div>
      <Card>
        {meetings.length ? (
          <table>
            <thead><tr><th>Contact</th><th>When (you / them)</th><th>Status</th><th>Meet</th><th /></tr></thead>
            <tbody>
              {meetings.map((m) => (
                <tr key={m.id}>
                  <td>{m.contact.company || m.contact.name}<div className="faint">{m.objective}</div></td>
                  <td className="small">{m.agreed ? <>{formatInZone(new Date(m.agreed.start), owner.timezone)}<div className="faint">{formatInZone(new Date(m.agreed.start), m.contact.timezone, m.contact.language || "en")}</div></> : `${m.proposedSlots.length} options proposed`}</td>
                  <td><Status value={m.status} />{m.calendar?.attendeeStatus ? <div className="faint">guest: {m.calendar.attendeeStatus}</div> : null}</td>
                  <td className="small">{m.calendar?.meetLink ? <a href={m.calendar.meetLink}>{m.calendar.meetLink.replace("https://", "")}</a> : "—"}</td>
                  <td className="row">
                    {m.status === "time_agreed" ? <form action={meetingInvite}><input type="hidden" name="id" value={m.id} /><Submit className="btn sm">Send invitation</Submit></form> : null}
                    <form action={meetingBrief}><input type="hidden" name="id" value={m.id} /><Submit className="btn sm">{m.brief ? "Refresh brief" : "Brief"}</Submit></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>No meetings yet.</Empty>}
        {meetings.filter((m) => m.brief).map((m) => (
          <details key={m.id} style={{ marginTop: 10 }}>
            <summary>Brief: {m.contact.company || m.contact.name}</summary>
            <div className="grid g2" style={{ marginTop: 8 }}>
              <div><strong>Objective</strong><p>{m.brief!.objective}</p><strong>History</strong><p>{m.brief!.previousCommunications}</p><strong>Opportunity</strong><p>{m.brief!.opportunity}</p></div>
              <div><strong>Questions to ask</strong><ul>{m.brief!.questions.map((x) => <li key={x}>{x}</li>)}</ul><strong>Documents</strong><ul>{m.brief!.documents.map((x) => <li key={x}>{x}</li>)}</ul><strong>Open commitments</strong><ul>{m.brief!.commitments.map((x) => <li key={x}>{x}</li>)}</ul><strong>Next steps</strong><ul>{m.brief!.nextSteps.map((x) => <li key={x}>{x}</li>)}</ul></div>
            </div>
          </details>
        ))}
      </Card>
    </>
  );
}
