import Link from "next/link";
import { getCtx } from "@/core/context";
import { getOwner } from "@/core/settings";
import { SEVERITIES, getEscalationPolicy, type Channel, type Incident } from "@/speak/escalation";
import { telephonyConfig } from "@/speak/telephony";
import { listLanguages } from "@/lang/translate";
import { Submit } from "../../client";
import { speakAck, speakDecide, speakInstruction, speakSave, speakTest } from "../../actions";
import { Ago, Badge, Card, Empty, PageHead, Status } from "../../ui";

export const dynamic = "force-dynamic";
const CHANNELS: Channel[] = ["activity", "app", "telegram", "email", "call"];

export default async function SpeakPage() {
  const ctx = getCtx();
  const [policy, owner, incidents, tel, langs] = await Promise.all([getEscalationPolicy(ctx), getOwner(ctx), ctx.store.list<Incident>("incidents", { limit: 30 }), telephonyConfig(ctx), listLanguages(ctx)]);
  const voice = langs.filter((l) => l.tts.length || l.stt.length);
  return (
    <>
      <PageHead title="BINGO Speak" sub="Priority calls, escalation rules and multilingual voice." />
      {!tel || !owner.phone ? <p className="notice">Phone escalation is off until a telephony provider and your phone number are set. <Link href="/settings#connections">Connect Twilio or Exotel</Link>.</p> : null}
      <div className="grid g2">
        <Card title="Tell BINGO how to reach you">
          <form action={speakInstruction}>
            <textarea name="instruction" placeholder="Call me immediately for all major business emergencies, but send routine matters to Telegram. Don't call me between 10pm and 7am." required />
            <div style={{ marginTop: 8 }}><Submit>Update policy</Submit></div>
          </form>
          {policy.history.slice(-4).reverse().map((h) => <div key={h.at} className="small" style={{ marginTop: 8 }}>“{h.instruction}” → {h.changes.join("; ")} <Ago iso={h.at} /></div>)}
        </Card>
        <Card title="Test">
          <p className="muted small">Sends a test through your policy exactly as a real incident would (calls only for CRITICAL, and only if allowed right now).</p>
          <form action={speakTest} className="row">
            <select name="severity" style={{ maxWidth: 160 }}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select>
            <Submit className="btn">Send test escalation</Submit>
          </form>
        </Card>
      </div>
      <Card title="Escalation policy">
        <form action={speakSave}>
          <table>
            <thead><tr><th>Severity</th>{CHANNELS.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {SEVERITIES.map((s) => (
                <tr key={s}>
                  <td><Badge tone={s === "CRITICAL" ? "bad" : s === "HIGH" ? "warn" : s === "MEDIUM" ? "info" : undefined}>{s}</Badge></td>
                  {CHANNELS.map((c) => <td key={c}><input type="checkbox" name={`ch_${s}`} value={c} defaultChecked={policy.channels[s].includes(c)} aria-label={`${s} ${c}`} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid g4" style={{ marginTop: 14 }}>
            <div className="field"><label><input type="checkbox" name="quietEnabled" defaultChecked={policy.quietHours.enabled} /> Quiet hours</label><div className="row" style={{ flexWrap: "nowrap" }}><input name="quietStart" defaultValue={policy.quietHours.start} /><input name="quietEnd" defaultValue={policy.quietHours.end} /></div><label style={{ marginTop: 6 }}><input type="checkbox" name="allowCritical" defaultChecked={policy.quietHours.allowCritical} /> Critical may still call</label></div>
            <div className="field"><label>Calls per incident / per day</label><div className="row" style={{ flexWrap: "nowrap" }}><input name="maxCallsPerIncident" type="number" defaultValue={policy.maxCallsPerIncident} /><input name="maxCallsPerDay" type="number" defaultValue={policy.maxCallsPerDay} /></div></div>
            <div className="field"><label>Re-try if not acknowledged (min)</label><input name="ackTimeoutMinutes" type="number" defaultValue={policy.ackTimeoutMinutes} /><label style={{ marginTop: 6 }}>Monthly call budget (USD)</label><input name="monthlyCallBudgetUsd" type="number" defaultValue={policy.monthlyCallBudgetUsd} /></div>
            <div className="field"><label>Do not disturb until</label><input name="dndUntil" type="datetime-local" defaultValue={policy.dndUntil ? policy.dndUntil.slice(0, 16) : ""} /><label style={{ marginTop: 6 }}>VIPs (one per line: company, email or domain)</label><textarea name="vip" defaultValue={policy.vip.map((v) => v.match).join("\n")} style={{ minHeight: 60 }} /></div>
          </div>
          <Submit>Save policy</Submit>
        </form>
      </Card>
      <div className="section-title"><h2>Incidents</h2></div>
      <div className="stack">
        {incidents.length ? incidents.map((i) => (
          <Card key={i.id} id={i.id} title={<span className="row"><Badge tone={i.severity === "CRITICAL" ? "bad" : i.severity === "HIGH" ? "warn" : "info"}>{i.severity}</Badge> {i.title} <Status value={i.status} /></span>} action={<Ago iso={i.createdAt} />}>
            <p>{i.summary}</p>
            <p className="small"><strong>Recommendation:</strong> {i.recommendation}</p>
            <details><summary>Details & delivery log</summary><pre>{i.details}</pre>{i.deliveries.map((d, k) => <div key={k} className="faint">{d.ok ? "✓" : "–"} {d.channel}: {d.detail} · <Ago iso={d.at} /></div>)}{i.calls.map((c) => <div key={c.sid} className="faint">📞 {c.provider} {c.sid}: {c.status}</div>)}</details>
            {i.decision ? <p className="notice good" style={{ marginTop: 8 }}>Decision: {i.decision.option} ({i.decision.via})</p> : null}
            {i.status !== "resolved" ? (
              <div className="row" style={{ marginTop: 10 }}>
                {i.status === "open" ? <form action={speakAck}><input type="hidden" name="id" value={i.id} /><Submit className="btn sm">Acknowledge</Submit></form> : null}
                {i.options.map((o, k) => <form key={k} action={speakDecide}><input type="hidden" name="id" value={i.id} /><input type="hidden" name="option" value={k} /><Submit className="btn sm" confirm={`Record your decision: “${o.label}”? BINGO records it; it will not commit on your behalf.`}>{o.label}</Submit></form>)}
              </div>
            ) : null}
          </Card>
        )) : <Card><Empty>No incidents.</Empty></Card>}
      </div>
      <Card title="Voice languages">
        {voice.length ? <p className="small">{voice.map((l) => `${l.name} (${[l.tts.length ? "speak" : "", l.stt.length ? "listen" : ""].filter(Boolean).join("+")})`).join(" · ")}</p> : <p className="muted small">No connected provider has reported voice languages yet. Calls use {tel?.provider === "twilio" ? `Twilio voice (${(tel as { language?: string }).language ?? "en-IN"})` : "your telephony provider's configured flow"}. BINGO will tell you when a language is not reliably supported instead of pretending.</p>}
      </Card>
    </>
  );
}
