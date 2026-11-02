import { getCtx } from "@/core/context";
import { listSkills } from "@/skills/engine";
import { Submit } from "../../client";
import { skillEdit, skillLearn, skillRate, skillToggle } from "../../actions";
import { Ago, Badge, Card, Empty, PageHead, Status } from "../../ui";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const skills = await listSkills(getCtx());
  return (
    <>
      <PageHead title="BINGO Skills" sub="Preferences and reusable workflows BINGO learned from you. They are plain, editable rules — they can never bypass approvals." />
      <Card title="Teach BINGO">
        <form action={skillLearn}>
          <textarea name="instruction" required placeholder={"Whenever I ask for distributor outreach in Russia, prepare the communication in Russian.\nEvery time we launch a new product, create a landing-page draft and marketing creative proposal.\nWhenever a distributor meeting is confirmed, create a follow-up task in my existing company Google Sheet."} />
          <div style={{ marginTop: 8 }}><Submit>Save skill</Submit></div>
        </form>
      </Card>
      <div className="section-title"><h2>Your skills</h2></div>
      <div className="stack">
        {skills.length ? skills.map((s) => (
          <Card key={s.id} title={<span className="row">{s.name} <Badge tone="info">{s.kind}</Badge> <Status value={s.status} /> <span className="faint">v{s.version} · used {s.uses}×</span></span>} action={<Ago iso={s.updatedAt} />}>
            <p className="muted small">“{s.createdFrom}”</p>
            <p className="small">When: {s.trigger.type === "event" ? <Badge>{s.trigger.event}</Badge> : <>{s.trigger.intents.map((i) => <Badge key={i}>{i}</Badge>)} {Object.entries(s.trigger.match).map(([k, v]) => <Badge key={k}>{k}={String(v)}</Badge>)}</>}</p>
            {s.validation.errors.map((e) => <p key={e} className="small" style={{ color: "var(--bad)" }}>✗ {e}</p>)}
            {s.validation.warnings.map((e) => <p key={e} className="faint">• {e}</p>)}
            <details>
              <summary className="small">Edit</summary>
              <form action={skillEdit} style={{ marginTop: 8 }}>
                <input type="hidden" name="id" value={s.id} />
                <div className="field"><label>Name</label><input name="name" defaultValue={s.name} /></div>
                <div className="field"><label>Effect (JSON)</label><textarea name="effect" defaultValue={JSON.stringify(s.effect, null, 2)} style={{ minHeight: 140, fontFamily: "monospace", fontSize: 12 }} /></div>
                <Submit className="btn sm">Save & validate</Submit>
              </form>
            </details>
            <div className="row" style={{ marginTop: 10 }}>
              <form action={skillToggle}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="status" value={s.status === "active" ? "disabled" : "active"} /><Submit className="btn sm">{s.status === "active" ? "Disable" : "Enable"}</Submit></form>
              <form action={skillRate} className="row">
                <input type="hidden" name="id" value={s.id} />
                <input name="text" placeholder="Feedback, e.g. “use Russian instead”" style={{ width: 260 }} />
                <Submit className="btn sm" name="rating" value="1">👍</Submit>
                <Submit className="btn sm" name="rating" value="-1">👎</Submit>
              </form>
            </div>
          </Card>
        )) : <Card><Empty>No skills yet — teach BINGO above or say “whenever …” in Ask BINGO.</Empty></Card>}
      </div>
    </>
  );
}
