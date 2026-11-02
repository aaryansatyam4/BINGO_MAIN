import { getCtx } from "@/core/context";
import { DEFAULT_MODES, ALWAYS_HUMAN, getPolicy, type ActionKind } from "@/core/policy";
import { getOwner } from "@/core/settings";
import { PROVIDERS } from "@/ai/catalog";
import { listConnections, spendThisMonth } from "@/ai/engine";
import { CAPABILITY_LABELS, type Capability } from "@/ai/types";
import { DATASET_HEADERS, type Dataset, type SheetLink } from "@/integrations/sheets-sync";
import { googleClient, googleConnected, GOOGLE_SCOPES } from "@/integrations/google";
import { githubAuth } from "@/integrations/github";
import { vercelAuth } from "@/integrations/vercel";
import { getTaskConfig } from "@/integrations/tasks";
import { telephonyConfig } from "@/speak/telephony";
import { listLanguages } from "@/lang/translate";
import { Submit } from "../../client";
import {
  logout, refreshLanguages, removeAiProvider, revokeSecret, saveAiProvider, saveGithub, saveGoogleClient, savePolicies, saveProfile, saveSheet, saveTasks, saveTelegram, saveTelephony, saveVercel, testAiProvider,
} from "../../actions";
import { Badge, Card, Money, PageHead } from "../../ui";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const ctx = getCtx();
  const [owner, conns, policy, links, gClient, gConn, gh, vc, tasks, tel, langs, secrets, repos] = await Promise.all([
    getOwner(ctx), listConnections(ctx), getPolicy(ctx), ctx.store.list<SheetLink>("sheet_links"), googleClient(ctx), googleConnected(ctx), githubAuth(ctx), vercelAuth(ctx), getTaskConfig(ctx), telephonyConfig(ctx), listLanguages(ctx), ctx.vault.list(), ctx.store.list<{ id: string; createdByBingo: boolean }>("repos"),
  ]);
  const spend = Object.fromEntries(await Promise.all(conns.map(async (c) => [c.id, await spendThisMonth(ctx, c.id)] as const)));
  return (
    <>
      <PageHead title="Settings" action={<form action={logout}><Submit className="btn sm">Sign out</Submit></form>} />

      <Card title="Profile" id="profile">
        <form action={saveProfile} className="grid g3">
          <div className="field"><label>Name</label><input name="name" defaultValue={owner.name} /></div>
          <div className="field"><label>Email (reports, previews)</label><input name="email" type="email" defaultValue={owner.email} /></div>
          <div className="field"><label>Phone for priority calls (E.164)</label><input name="phone" defaultValue={owner.phone} placeholder="+9198…" /></div>
          <div className="field"><label>Time zone (IANA)</label><input name="timezone" defaultValue={owner.timezone} /></div>
          <div className="field"><label>Preferred language</label><input name="preferredLanguage" defaultValue={owner.preferredLanguage} /></div>
          <div className="field"><label>Telegram chat ID</label><input name="telegramChatId" defaultValue={owner.telegramChatId} /></div>
          <div className="field"><label>Working hours</label><div className="row" style={{ flexWrap: "nowrap" }}><input name="start" defaultValue={owner.workingHours.start} /><input name="end" defaultValue={owner.workingHours.end} /></div></div>
          <div className="field" style={{ gridColumn: "span 2" }}><label>Working days</label><div className="checks">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => <label key={d}><input type="checkbox" name="days" value={i + 1} defaultChecked={owner.workingHours.days.includes(i + 1)} /> {d}</label>)}</div></div>
          <div><Submit>Save profile</Submit></div>
        </form>
      </Card>

      <div className="section-title" id="ai"><h2>AI Models</h2><span className="faint">BINGO routes each task to the best connected model by capability, cost, latency and measured reliability.</span></div>
      <div className="stack">
        {PROVIDERS.map((p) => {
          const c = conns.find((x) => x.id === p.id);
          const caps = [...new Set(p.models.flatMap((m) => m.capabilities))] as Capability[];
          return (
            <Card key={p.id} title={<span className="row">{p.name} {c ? (c.lastTest?.ok ? <Badge tone="good">connected</Badge> : <Badge tone="warn">{c.lastTest ? "test failed" : "untested"}</Badge>) : <Badge>not connected</Badge>}</span>} action={c ? <span className="faint">this month <Money usd={spend[p.id] ?? 0} /> of ${c.monthlyLimitUsd}</span> : <a className="small" href={p.docsUrl} target="_blank" rel="noreferrer">docs</a>}>
              <p className="muted small">{p.summary}</p>
              {c?.lastTest && !c.lastTest.ok ? <p className="notice bad small">{c.lastTest.detail}</p> : null}
              <details open={!c}>
                <summary className="small">{c ? "Configure" : "Connect"}</summary>
                <form action={saveAiProvider} style={{ marginTop: 10 }}>
                  <input type="hidden" name="provider" value={p.id} />
                  <div className="grid g3">
                    {p.credentialFields.map((f) => <div className="field" key={f.key}><label>{f.label}{c ? " (leave blank to keep)" : ""}</label><input name={`cred_${f.key}`} type={f.secret ? "password" : "text"} placeholder={f.placeholder} autoComplete="off" /></div>)}
                    <div className="field"><label>Monthly spending limit (USD)</label><input name="monthlyLimitUsd" type="number" min={0} step="1" defaultValue={c?.monthlyLimitUsd ?? 50} /></div>
                  </div>
                  <label>Capabilities to use</label>
                  <div className="checks" style={{ marginBottom: 10 }}>{caps.map((cap) => <label key={cap}><input type="checkbox" name="capabilities" value={cap} defaultChecked={!c || c.capabilities.includes(cap)} /> {CAPABILITY_LABELS[cap]}</label>)}</div>
                  <div className="grid g3">
                    {caps.map((cap) => {
                      const models = p.models.filter((m) => m.capabilities.includes(cap));
                      return (
                        <div key={cap} className="field">
                          <label>{CAPABILITY_LABELS[cap]} — preferred / fallbacks</label>
                          <select name={`pref_${cap}`} defaultValue={c?.preferred[cap] ?? ""}><option value="">automatic</option>{models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.priceSource === "estimate" ? " (price est.)" : ""}</option>)}</select>
                          <input name={`fb_${cap}`} placeholder="fallback model ids, comma separated" defaultValue={c?.fallbacks[cap]?.join(", ") ?? ""} style={{ marginTop: 4 }} />
                        </div>
                      );
                    })}
                  </div>
                  <label className="row" style={{ color: "var(--text)" }}><input type="checkbox" name="enabled" defaultChecked={c?.enabled ?? true} /> Enabled</label>
                  <div className="row" style={{ marginTop: 10 }}><Submit>{c ? "Save & test" : "Connect & test"}</Submit></div>
                </form>
                {c ? (
                  <div className="row" style={{ marginTop: 8 }}>
                    <form action={testAiProvider}><input type="hidden" name="provider" value={p.id} /><Submit className="btn sm">Test connection</Submit></form>
                    <form action={removeAiProvider}><input type="hidden" name="provider" value={p.id} /><Submit className="btn sm bad" confirm="Remove this provider and delete its stored credentials?">Remove & revoke</Submit></form>
                    {c.lastTest ? <span className="faint">{c.lastTest.detail}</span> : null}
                  </div>
                ) : null}
              </details>
            </Card>
          );
        })}
      </div>

      <div className="section-title" id="connections"><h2>Connections</h2><span className="faint">Least-privilege access; every token is encrypted server-side and can be revoked below.</span></div>
      <div className="grid g2">
        <Card title={<span className="row">Google — Gmail, Calendar, Sheets, Contacts {gConn ? <Badge tone="good">{gConn.email ?? "connected"}</Badge> : null}</span>}>
          <form action={saveGoogleClient} className="grid g2">
            <div className="field"><label>OAuth client ID {gClient ? "(set)" : ""}</label><input name="clientId" /></div>
            <div className="field"><label>Client secret</label><input name="clientSecret" type="password" /></div>
            <div><Submit className="btn sm">Save client</Submit></div>
          </form>
          <p className="faint">Redirect URI: <code>{ctx.env.publicUrl}/api/oauth/google/callback</code></p>
          <p className="faint">Scopes: {GOOGLE_SCOPES.map((s) => s.replace("https://www.googleapis.com/auth/", "")).join(", ")}</p>
          <a className="btn primary" href="/api/oauth/google/start">Authorize Google</a>
        </Card>
        <Card title="Google Sheets (editable business data)">
          {(Object.keys(DATASET_HEADERS) as Dataset[]).map((d) => {
            const l = links.find((x) => x.id === d);
            return (
              <form key={d} action={saveSheet} className="row" style={{ marginBottom: 6, flexWrap: "nowrap" }}>
                <input type="hidden" name="dataset" value={d} />
                <span style={{ width: 90 }} className="small">{d}</span>
                <input name="spreadsheetId" placeholder="Spreadsheet URL or ID" defaultValue={l?.spreadsheetId} required />
                <input name="tab" placeholder="Tab" defaultValue={l?.tab ?? d[0]!.toUpperCase() + d.slice(1)} style={{ width: 110 }} required />
                <Submit className="btn sm">Link</Submit>
              </form>
            );
          })}
          <p className="faint">BINGO writes only its own columns (matched by header), keeps your formulas and extra columns, and creates a tab with headers only if it does not exist.</p>
        </Card>
        <Card title={<span className="row">Company task sheet (ISSHAAN Task System) {tasks?.apiUrl ? <Badge tone="good">connected</Badge> : null}</span>}>
          <form action={saveTasks}>
            <div className="field"><label>Apps Script web app URL</label><input name="apiUrl" defaultValue={tasks?.apiUrl} placeholder="https://script.google.com/macros/s/…/exec" /></div>
            <div className="grid g3">
              <div className="field"><label>BINGO login ID</label><input name="loginId" defaultValue={tasks?.loginId} /></div>
              <div className="field"><label>Password {tasks ? "(leave blank to keep)" : ""}</label><input name="password" type="password" /></div>
              <div className="field"><label>Default level</label><select name="defaultLevel" defaultValue={tasks?.defaultLevel ?? 2}><option value={1}>L1 Critical</option><option value={2}>L2 Important</option><option value={3}>L3 Routine</option></select></div>
            </div>
            <div className="field"><label>Who gets which follow-up (kind: Staff name)</label><textarea name="routing" defaultValue={Object.entries(tasks?.routing ?? { default: "Aryan Satyam", design_approval: "Ritesh Kr. Dubey", regulatory_verification: "Naveen Gupta", documentation_request: "Rajat Kumar", distributor_followup: "Aryan Satyam", meeting_followup: "Aryan Satyam", website_testing: "Aryan Satyam" }).map(([k, v]) => `${k}: ${v}`).join("\n")} /></div>
            <Submit className="btn sm">Save</Submit>
          </form>
          <p className="faint">BINGO creates tasks through the same API the dashboard uses — your Tasks sheet, reminders, levels and approvals keep working unchanged. Each task carries a [BINGO:…] reference so it is never duplicated.</p>
        </Card>
        <Card title={<span className="row">GitHub {gh ? <Badge tone="good">{gh.login}</Badge> : null}</span>}>
          <a className="btn primary" href="/api/oauth/github/start">Authorize GitHub</a>
          <form action={saveGithub} style={{ marginTop: 10 }}>
            <div className="field"><label>…or a fine-grained token</label><input name="token" type="password" placeholder="github_pat_…" /></div>
            <div className="field"><label>Allow BINGO to work in an existing repository (owner/name)</label><input name="allowRepo" placeholder="aaryansatyam4/carpediem-site" /></div>
            <Submit className="btn sm">Save</Submit>
          </form>
          <p className="faint">Allowed repositories: {repos.map((r) => `${r.id}${r.createdByBingo ? " (created by BINGO)" : ""}`).join(", ") || "none yet"}. BINGO works on branches and pull requests; it never overwrites an existing repository.</p>
        </Card>
        <Card title={<span className="row">Vercel {vc ? <Badge tone="good">{vc.user}</Badge> : null}</span>}>
          {process.env.VERCEL_INTEGRATION_SLUG ? <a className="btn primary" href={`https://vercel.com/integrations/${process.env.VERCEL_INTEGRATION_SLUG}/new`}>Authorize Vercel</a> : null}
          <form action={saveVercel} style={{ marginTop: 10 }}>
            <div className="grid g2">
              <div className="field"><label>Access token</label><input name="token" type="password" /></div>
              <div className="field"><label>Team ID (optional)</label><input name="teamId" defaultValue={vc?.teamId} /></div>
              <div className="field"><label>Protection bypass secret (to verify protected previews)</label><input name="bypass" type="password" /></div>
              <div className="field"><label>Sandbox project ID (Vercel Sandbox for isolated builds)</label><input name="sandboxProjectId" placeholder="prj_…" /></div>
            </div>
            <Submit className="btn sm">Save</Submit>
          </form>
          <p className="faint">Previews deploy automatically within your limits; production, domain changes and rollbacks always need your approval.</p>
        </Card>
        <Card title="Telegram">
          <p className="notice small">Use a <strong>separate bot for BINGO</strong>. The ISSHAAN task system polls its own bot with getUpdates and removes webhooks, so sharing one bot would break both.</p>
          <form action={saveTelegram}>
            <div className="grid g2">
              <div className="field"><label>Bot token (from @BotFather)</label><input name="token" type="password" /></div>
              <div className="field"><label>Your chat ID (send /start to the bot)</label><input name="chatId" defaultValue={owner.telegramChatId} /></div>
            </div>
            <div className="checks"><label><input type="checkbox" name="webhook" /> Register webhook (approve from Telegram)</label><label><input type="checkbox" name="test" /> Send test message</label></div>
            <div style={{ marginTop: 8 }}><Submit className="btn sm">Save</Submit></div>
          </form>
        </Card>
        <Card title={<span className="row">Phone calls {tel ? <Badge tone="good">{tel.provider}</Badge> : null}</span>}>
          <form action={saveTelephony}>
            <div className="field"><label>Provider</label><select name="provider" defaultValue={tel?.provider ?? "twilio"}><option value="twilio">Twilio</option><option value="exotel">Exotel (India)</option></select></div>
            <div className="grid g3">
              <div className="field"><label>Twilio Account SID</label><input name="accountSid" /></div>
              <div className="field"><label>Twilio Auth token</label><input name="authToken" type="password" /></div>
              <div className="field"><label>Twilio number (E.164)</label><input name="from" /></div>
              <div className="field"><label>Voice (optional)</label><input name="voice" placeholder="Polly.Aditi" /></div>
              <div className="field"><label>Speech language</label><input name="language" placeholder="en-IN" /></div>
            </div>
            <div className="grid g3">
              <div className="field"><label>Exotel SID</label><input name="sid" /></div>
              <div className="field"><label>API key</label><input name="apiKey" /></div>
              <div className="field"><label>API token</label><input name="apiToken" type="password" /></div>
              <div className="field"><label>Subdomain</label><input name="subdomain" placeholder="api.exotel.com" /></div>
              <div className="field"><label>ExoPhone (caller ID)</label><input name="callerId" /></div>
              <div className="field"><label>Flow URL</label><input name="flowUrl" /></div>
            </div>
            <Submit className="btn sm">Save</Submit>
          </form>
        </Card>
      </div>

      <div className="section-title" id="policies"><h2>Approval policy</h2><span className="faint">Deterministic: the AI cannot change or bypass these.</span></div>
      <Card>
        <form action={savePolicies}>
          <table>
            <tbody>
              {(Object.keys(DEFAULT_MODES) as ActionKind[]).map((k) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>
                    <select name={`mode_${k}`} defaultValue={policy.modes[k]} style={{ maxWidth: 200 }}>
                      {!ALWAYS_HUMAN.includes(k) ? <option value="auto">automatic</option> : null}
                      <option value="approval">ask me</option>
                      <option value="forbidden">never</option>
                    </select>
                  </td>
                  <td className="faint">{ALWAYS_HUMAN.includes(k) ? "always requires a human" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid g4" style={{ marginTop: 12 }}>
            {Object.entries(policy.limits).map(([k, v]) => <div className="field" key={k}><label>{k}</label><input name={k} type="number" defaultValue={v} /></div>)}
          </div>
          <Submit>Save policy</Submit>
        </form>
      </Card>

      <div className="section-title"><h2>Languages</h2><span className="faint">Discovered from connected providers — not a fixed list.</span></div>
      <Card action={<form action={refreshLanguages}><Submit className="btn sm">Discover languages</Submit></form>}>
        {langs.length ? <p className="small">{langs.length} languages: {langs.map((l) => `${l.name}${l.rtl ? " (RTL)" : ""}`).join(" · ")}</p> : <p className="muted small">Connect a translation provider (Google Translate or DeepL) and press Discover. Claude also writes many languages; uncertain translations are always marked for your review.</p>}
      </Card>

      <div className="section-title"><h2>Stored credentials</h2></div>
      <Card>
        <table>
          <tbody>
            {secrets.filter((x) => !x.name.startsWith("webhook") && !x.name.startsWith("lead_secret")).map((x) => (
              <tr key={x.id}><td><code>{x.id}</code></td><td className="faint">{x.hint}</td><td className="faint">{x.meta ? Object.values(x.meta).filter(Boolean).join(" ") : ""}</td><td><form action={revokeSecret}><input type="hidden" name="id" value={x.id} /><Submit className="btn sm bad" confirm={`Revoke ${x.id}?`}>Revoke</Submit></form></td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
