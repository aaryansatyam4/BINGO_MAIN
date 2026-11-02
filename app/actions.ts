"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getCtx } from "@/core/context";
import { logActivity } from "@/core/context";
import { savePolicy, setKillSwitch, type ActionKind, type Mode } from "@/core/policy";
import { saveOwner } from "@/core/settings";
import { errorMessage } from "@/core/util";
import { removeConnection, saveConnection, testConnection } from "@/ai/engine";
import { descriptor } from "@/ai/catalog";
import type { Capability, ProviderId } from "@/ai/types";
import { askBingo } from "@/orchestrator/planner";
import { controlWorkflow, createWorkflow, modifyStep, runWorkflows } from "@/orchestrator/workflow";
import { decideAndContinue } from "@/web/approvals";
import { SESSION_COOKIE, checkPassword, createSession } from "@/web/session";
import { saveSheetLink, type Dataset } from "@/integrations/sheets-sync";
import { allowRepo, githubConnectToken } from "@/integrations/github";
import { vercelConnectToken } from "@/integrations/vercel";
import { telegramSend, telegramSetWebhook } from "@/integrations/telegram";
import { saveTaskConfig } from "@/integrations/tasks";
import { refreshLanguageRegistry } from "@/lang/translate";
import { getBrandKit, saveAsset, saveBrandKit } from "@/studio/brand";
import { editCreative, setCreativeStatus } from "@/studio/creative";
import { updateContent } from "@/build/developer";
import { editDraft, requestSendApproval } from "@/global/outreach";
import { getLead, saveLead, setStage, type Lead, type Stage } from "@/global/crm";
import { createCalendarInvite, generateBrief, proposeMeeting } from "@/calendar/meetings";
import { acknowledge, applyPolicyInstruction, decide, escalate, getEscalationPolicy, saveEscalationPolicy, type Severity } from "@/speak/escalation";
import { learnSkill, skillFeedback, updateSkill } from "@/skills/engine";
import { newId } from "@/core/util";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const kick = () => after(async () => void (await runWorkflows(getCtx(), 50_000).catch(() => undefined)));

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function login(_prev: unknown, f: FormData) {
  if (!(await checkPassword(s(f, "password")))) return { error: "Wrong password." };
  (await cookies()).set(SESSION_COOKIE, await createSession(), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 14 * 86400 });
  redirect(s(f, "next") || "/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

// ---------------------------------------------------------------------------
// Ask BINGO, approvals, workflows, emergency stop
// ---------------------------------------------------------------------------

export async function ask(_prev: unknown, f: FormData): Promise<{ notes?: string[]; error?: string }> {
  const text = s(f, "text");
  if (!text) return { error: "Tell BINGO what you want to achieve." };
  let id: string | null = null;
  try {
    const { workflow, plan } = await askBingo(getCtx(), text);
    if (!workflow) return { notes: plan.notes };
    id = workflow.id;
  } catch (e) {
    return { error: errorMessage(e) };
  }
  kick();
  redirect(`/workflows/${id}`);
}

export async function decideApprovalAction(f: FormData) {
  const ctx = getCtx();
  const r = await decideAndContinue(ctx, s(f, "id"), s(f, "decision") === "approve" ? "approved" : "rejected", "dashboard", s(f, "note") || undefined);
  await logActivity(ctx, { actor: "owner", action: "approval.result", summary: `${r.approval.title}: ${r.result}`, level: r.result.includes("failed") ? "error" : "info", ref: { kind: "approval", id: r.approval.id } });
  kick();
  revalidatePath("/", "layout");
}

export async function workflowControl(f: FormData) {
  await controlWorkflow(getCtx(), s(f, "id"), s(f, "action") as "pause" | "resume" | "cancel");
  if (s(f, "action") === "resume") kick();
  revalidatePath(`/workflows/${s(f, "id")}`);
}

export async function stepControl(f: FormData) {
  const action = s(f, "action");
  const params = s(f, "params");
  await modifyStep(getCtx(), s(f, "id"), s(f, "step"), action === "retry" ? { retry: true } : action === "skip" ? { skip: true } : { params: JSON.parse(params || "{}") });
  kick();
  revalidatePath(`/workflows/${s(f, "id")}`);
}

export async function emergencyStop(f: FormData) {
  await setKillSwitch(getCtx(), "global", s(f, "on") === "1", s(f, "reason") || "Owner pressed emergency stop");
  revalidatePath("/", "layout");
}

export async function runNow() {
  await runWorkflows(getCtx(), 50_000);
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function saveProfile(f: FormData) {
  await saveOwner(getCtx(), {
    name: s(f, "name"),
    email: s(f, "email"),
    phone: s(f, "phone"),
    timezone: s(f, "timezone") || "Asia/Kolkata",
    preferredLanguage: s(f, "preferredLanguage") || "en",
    telegramChatId: s(f, "telegramChatId"),
    workingHours: { start: s(f, "start") || "10:00", end: s(f, "end") || "19:00", days: (f.getAll("days") as string[]).map(Number) },
  });
  revalidatePath("/settings");
}

export async function saveAiProvider(f: FormData) {
  const id = s(f, "provider") as ProviderId;
  const d = descriptor(id);
  const credentials: Record<string, string> = {};
  for (const field of d.credentialFields) if (s(f, `cred_${field.key}`)) credentials[field.key] = s(f, `cred_${field.key}`);
  const preferred: Partial<Record<Capability, string>> = {};
  const fallbacks: Partial<Record<Capability, string[]>> = {};
  for (const [k, v] of f.entries()) {
    if (k.startsWith("pref_") && String(v)) preferred[k.slice(5) as Capability] = String(v);
    if (k.startsWith("fb_") && String(v)) fallbacks[k.slice(3) as Capability] = String(v).split(",").map((x) => x.trim()).filter(Boolean);
  }
  const ctx = getCtx();
  await saveConnection(ctx, id, {
    credentials: Object.keys(credentials).length ? credentials : undefined,
    enabled: f.get("enabled") === "on",
    capabilities: f.getAll("capabilities") as Capability[],
    monthlyLimitUsd: Number(s(f, "monthlyLimitUsd") || 50),
    preferred,
    fallbacks,
  });
  await testConnection(ctx, id).catch(() => undefined);
  await logActivity(ctx, { actor: "owner", action: "ai.connection.saved", summary: `${d.name} connection saved`, level: "success" });
  revalidatePath("/settings");
}

export async function testAiProvider(f: FormData) {
  await testConnection(getCtx(), s(f, "provider") as ProviderId);
  revalidatePath("/settings");
}

export async function removeAiProvider(f: FormData) {
  await removeConnection(getCtx(), s(f, "provider") as ProviderId);
  revalidatePath("/settings");
}

export async function saveGoogleClient(f: FormData) {
  const ctx = getCtx();
  if (s(f, "clientId")) await ctx.vault.set("global", "google:client_id", s(f, "clientId"));
  if (s(f, "clientSecret")) await ctx.vault.set("global", "google:client_secret", s(f, "clientSecret"));
  revalidatePath("/settings");
}

export async function saveSheet(f: FormData) {
  await saveSheetLink(getCtx(), { id: s(f, "dataset") as Dataset, spreadsheetId: s(f, "spreadsheetId").replace(/^.*\/d\/([^/]+).*$/, "$1"), tab: s(f, "tab") });
  revalidatePath("/settings");
}

export async function saveGithub(f: FormData) {
  const ctx = getCtx();
  if (s(f, "token")) await githubConnectToken(ctx, s(f, "token"));
  if (s(f, "allowRepo")) await allowRepo(ctx, s(f, "allowRepo"));
  revalidatePath("/settings");
}

export async function saveVercel(f: FormData) {
  const ctx = getCtx();
  if (s(f, "token")) await vercelConnectToken(ctx, s(f, "token"), s(f, "teamId") || undefined, "token", s(f, "bypass") || undefined);
  if (s(f, "sandboxProjectId")) {
    const auth = await ctx.vault.getJson<{ token: string; teamId?: string }>("global", "vercel");
    if (!auth?.teamId) throw new Error("Vercel Sandbox needs a team ID.");
    await ctx.vault.setJson("global", "vercel:sandbox", { token: auth.token, teamId: auth.teamId, projectId: s(f, "sandboxProjectId") });
  }
  revalidatePath("/settings");
}

export async function saveTelegram(f: FormData) {
  const ctx = getCtx();
  if (s(f, "token")) await ctx.vault.set("global", "telegram:bot_token", s(f, "token"));
  if (s(f, "chatId")) await saveOwner(ctx, { telegramChatId: s(f, "chatId") });
  if (f.get("webhook") === "on") await telegramSetWebhook(ctx);
  if (f.get("test") === "on") await telegramSend(ctx, "👋 BINGO is connected to Telegram.");
  revalidatePath("/settings");
}

export async function saveTelephony(f: FormData) {
  const ctx = getCtx();
  if (s(f, "provider") === "twilio") await ctx.vault.setJson("global", "telephony", { provider: "twilio", accountSid: s(f, "accountSid"), authToken: s(f, "authToken"), from: s(f, "from"), voice: s(f, "voice") || undefined, language: s(f, "language") || "en-IN" });
  else await ctx.vault.setJson("global", "telephony", { provider: "exotel", sid: s(f, "sid"), apiKey: s(f, "apiKey"), apiToken: s(f, "apiToken"), subdomain: s(f, "subdomain") || "api.exotel.com", callerId: s(f, "callerId"), flowUrl: s(f, "flowUrl") });
  revalidatePath("/settings");
}

export async function saveTasks(f: FormData) {
  const routing: Record<string, string> = {};
  for (const line of s(f, "routing").split("\n")) {
    const [k, v] = line.split(/[:=]/).map((x) => x?.trim());
    if (k && v) routing[k] = v;
  }
  await saveTaskConfig(getCtx(), { apiUrl: s(f, "apiUrl"), loginId: s(f, "loginId"), routing, defaultLevel: (Number(s(f, "defaultLevel")) || 2) as 1 | 2 | 3 }, s(f, "password") || undefined);
  revalidatePath("/settings");
}

export async function savePolicies(f: FormData) {
  const modes: Partial<Record<ActionKind, Mode>> = {};
  for (const [k, v] of f.entries()) if (k.startsWith("mode_")) modes[k.slice(5) as ActionKind] = String(v) as Mode;
  const num = (k: string, d: number) => Number(s(f, k) || d);
  await savePolicy(getCtx(), "global", { modes, limits: { previewDeploysPerDay: num("previewDeploysPerDay", 20), initialEmailsPerDay: num("initialEmailsPerDay", 40), initialEmailsPerDomainPerDay: num("initialEmailsPerDomainPerDay", 2), minSecondsBetweenEmails: num("minSecondsBetweenEmails", 20), callsPerDay: num("callsPerDay", 6) } });
  revalidatePath("/settings");
}

export async function refreshLanguages() {
  await refreshLanguageRegistry(getCtx());
  revalidatePath("/settings");
}

export async function revokeSecret(f: FormData) {
  const [scope, ...name] = s(f, "id").split(":");
  await getCtx().vault.revoke(scope!, name.join(":"));
  await logActivity(getCtx(), { actor: "owner", action: "secret.revoked", summary: `Revoked credential ${s(f, "id")}`, level: "warning" });
  revalidatePath("/settings");
}

// ---------------------------------------------------------------------------
// Studio
// ---------------------------------------------------------------------------

export async function studioGenerate(f: FormData) {
  const ctx = getCtx();
  const kit = await getBrandKit(ctx, s(f, "brandKitId"));
  const wf = await createWorkflow(ctx, {
    goal: `Studio: ${s(f, "brief").slice(0, 80)}`,
    request: s(f, "brief"),
    workspaceId: kit?.workspaceId,
    source: { kind: "ui" },
    steps: [{ type: "studio.generate", params: { brief: [s(f, "brief"), s(f, "style") && `Style references: ${s(f, "style")}`].filter(Boolean).join("\n"), brandKitId: s(f, "brandKitId"), productId: s(f, "productId") || null, count: Number(s(f, "count") || 3), formats: f.getAll("formats").map(String), language: s(f, "language") || undefined, workspaceId: kit?.workspaceId } }],
  });
  kick();
  redirect(`/workflows/${wf.id}`);
}

export async function studioEdit(f: FormData) {
  const ctx = getCtx();
  const r = await editCreative(ctx, s(f, "id"), s(f, "instruction"));
  if (r.refused.length) await logActivity(ctx, { actor: "bingo", action: "studio.edit.refused", summary: r.refused.join(" "), level: "warning", ref: { kind: "creative", id: s(f, "id") } });
  revalidatePath(`/studio/${s(f, "id")}`);
}

export async function studioStatus(f: FormData) {
  await setCreativeStatus(getCtx(), s(f, "id"), s(f, "status") as "approved" | "rejected");
  revalidatePath(`/studio/${s(f, "id")}`);
}

export async function saveBrand(f: FormData) {
  const ctx = getCtx();
  const kit = (await getBrandKit(ctx, s(f, "id")))!;
  const lines = (k: string) => s(f, k).split("\n").map((x) => x.trim()).filter(Boolean);
  kit.name = s(f, "name") || kit.name;
  kit.verified = f.get("verified") === "on";
  for (const c of Object.keys(kit.colors) as (keyof typeof kit.colors)[]) kit.colors[c] = s(f, `color_${c}`) || kit.colors[c];
  kit.fonts = { heading: s(f, "fontHeading") || kit.fonts.heading, body: s(f, "fontBody") || kit.fonts.body };
  kit.tone = s(f, "tone").split(",").map((x) => x.trim()).filter(Boolean);
  kit.visualGuidelines = s(f, "visualGuidelines");
  kit.targetAudience = s(f, "targetAudience");
  kit.regulatoryConstraints = lines("regulatoryConstraints");
  kit.forbiddenPhrases = s(f, "forbiddenPhrases").split(",").map((x) => x.trim()).filter(Boolean);
  kit.companyFacts = lines("companyFacts");
  const logo = f.get("logo");
  if (logo instanceof File && logo.size) {
    const a = await saveAsset(ctx, { workspaceId: kit.workspaceId, name: logo.name, mime: logo.type, b64: Buffer.from(await logo.arrayBuffer()).toString("base64"), kind: "logo", approved: true, source: "upload" });
    kit.logoAssetId = a.id;
  }
  await saveBrandKit(ctx, kit);
  revalidatePath("/studio/brand");
}

export async function saveProduct(f: FormData) {
  const ctx = getCtx();
  const kit = (await getBrandKit(ctx, s(f, "kitId")))!;
  let p = kit.products.find((x) => x.id === s(f, "productId"));
  const isNew = !p;
  if (!p) {
    p = { id: newId("prod"), name: s(f, "name"), category: "", description: "", approvedClaims: [], facts: [], packshotAssetIds: [], photoAssetIds: [], disclaimer: "" };
    kit.products.push(p);
  }
  p.name = s(f, "name") || p.name;
  p.category = s(f, "category");
  p.description = s(f, "description");
  p.disclaimer = s(f, "disclaimer");
  p.facts = s(f, "facts").split("\n").map((x) => x.trim()).filter(Boolean);
  const existing = new Map(p.approvedClaims.map((c) => [c.text, c]));
  p.approvedClaims = s(f, "claims").split("\n").map((x) => x.trim()).filter(Boolean).map((text, i) => existing.get(text) ?? { id: `${p!.id}_c${Date.now().toString(36)}${i}`, text, approvedBy: "owner", approvedAt: new Date().toISOString() });
  const pack = f.get("packshot");
  if (pack instanceof File && pack.size) {
    const a = await saveAsset(ctx, { workspaceId: kit.workspaceId, name: pack.name, mime: pack.type, b64: Buffer.from(await pack.arrayBuffer()).toString("base64"), width: Number(s(f, "packWidth")) || undefined, height: Number(s(f, "packHeight")) || undefined, kind: "packshot", approved: true, source: "upload" });
    p.packshotAssetIds = [a.id, ...p.packshotAssetIds];
  }
  await saveBrandKit(ctx, kit);
  if (isNew) {
    const { emitEvent } = await import("@/skills/engine");
    await emitEvent(ctx, "product.launched", { product: p.name, workspaceId: kit.workspaceId });
    kick();
  }
  revalidatePath("/studio/brand");
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function buildUpdateCopy(f: FormData) {
  const ctx = getCtx();
  const p = await updateContent(ctx, s(f, "id"), s(f, "locale"), s(f, "json"));
  const wf = await createWorkflow(ctx, {
    goal: `Rebuild ${p.name} r${p.revision}`,
    workspaceId: p.workspaceId,
    source: { kind: "ui" },
    steps: [
      { id: "test", type: "build.checks", params: { projectId: p.id } },
      { id: "git", type: "build.github", params: { projectId: p.id } },
      { id: "preview", type: "build.preview", params: { projectId: p.id } },
      { id: "production", type: "build.production", params: { projectId: p.id } },
    ],
  });
  kick();
  redirect(`/workflows/${wf.id}`);
}

export async function buildPublish(f: FormData) {
  const ctx = getCtx();
  const wf = await createWorkflow(ctx, { goal: `Publish project ${s(f, "id")}`, source: { kind: "ui" }, steps: [{ type: "build.production", params: { projectId: s(f, "id") } }] });
  kick();
  redirect(`/workflows/${wf.id}`);
}

export async function buildRollback(f: FormData) {
  const { rollback } = await import("@/build/developer");
  await rollback(getCtx(), s(f, "id"), s(f, "deploymentId"));
  revalidatePath(`/build/${s(f, "id")}`);
}

export async function buildDomain(f: FormData) {
  const { connectDomain } = await import("@/build/developer");
  await connectDomain(getCtx(), s(f, "id"), s(f, "domain"));
  revalidatePath(`/build/${s(f, "id")}`);
}

// ---------------------------------------------------------------------------
// Global
// ---------------------------------------------------------------------------

export async function globalSendSelected(f: FormData) {
  const ids = f.getAll("ids").map(String);
  if (ids.length) await requestSendApproval(getCtx(), ids);
  revalidatePath("/global");
}

export async function globalEditDraft(f: FormData) {
  await editDraft(getCtx(), s(f, "id"), { subject: s(f, "subject"), body: s(f, "body"), to: s(f, "to") });
  revalidatePath("/global");
}

export async function leadUpdate(f: FormData) {
  const ctx = getCtx();
  let lead: Lead = (await getLead(ctx, s(f, "id")))!;
  if (s(f, "stage") && s(f, "stage") !== lead.stage) lead = await setStage(ctx, lead, s(f, "stage") as Stage, "owner");
  lead = { ...lead, notes: s(f, "notes"), owner: s(f, "owner"), language: s(f, "language") || lead.language, languageSource: s(f, "language") ? "manual" : lead.languageSource };
  if (s(f, "email") && !lead.emails.some((e) => e.address === s(f, "email"))) lead.emails = [{ address: s(f, "email"), source: "manual", verified: true, note: "added by owner" }, ...lead.emails];
  await saveLead(ctx, lead);
  revalidatePath(`/global/${lead.id}`);
}

export async function leadProposeMeeting(f: FormData) {
  await proposeMeeting(getCtx(), { leadId: s(f, "id"), objective: s(f, "objective") || "Introductory call about distribution partnership", durationMin: Number(s(f, "duration") || 30) });
  revalidatePath(`/global/${s(f, "id")}`);
}

export async function meetingInvite(f: FormData) {
  await createCalendarInvite(getCtx(), s(f, "id"));
  revalidatePath("/global");
}

export async function meetingBrief(f: FormData) {
  await generateBrief(getCtx(), s(f, "id"));
  revalidatePath("/global");
}

// ---------------------------------------------------------------------------
// Speak
// ---------------------------------------------------------------------------

export async function speakInstruction(f: FormData) {
  const ctx = getCtx();
  const { policy, changes } = applyPolicyInstruction(await getEscalationPolicy(ctx), s(f, "instruction"), ctx.now());
  if (changes.length) await saveEscalationPolicy(ctx, policy);
  revalidatePath("/speak");
}

export async function speakSave(f: FormData) {
  const ctx = getCtx();
  const p = await getEscalationPolicy(ctx);
  for (const sev of ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Severity[]) p.channels[sev] = f.getAll(`ch_${sev}`).map(String) as never;
  p.quietHours = { enabled: f.get("quietEnabled") === "on", start: s(f, "quietStart") || "22:00", end: s(f, "quietEnd") || "07:00", allowCritical: f.get("allowCritical") === "on" };
  p.maxCallsPerIncident = Number(s(f, "maxCallsPerIncident") || 2);
  p.maxCallsPerDay = Number(s(f, "maxCallsPerDay") || 4);
  p.ackTimeoutMinutes = Number(s(f, "ackTimeoutMinutes") || 10);
  p.monthlyCallBudgetUsd = Number(s(f, "monthlyCallBudgetUsd") || 25);
  p.dndUntil = s(f, "dndUntil") ? new Date(s(f, "dndUntil")).toISOString() : null;
  p.vip = s(f, "vip").split("\n").map((x) => x.trim()).filter(Boolean).map((match) => ({ match, minSeverity: "HIGH" as Severity }));
  await saveEscalationPolicy(ctx, p);
  revalidatePath("/speak");
}

export async function speakAck(f: FormData) {
  await acknowledge(getCtx(), s(f, "id"), "dashboard");
  revalidatePath("/speak");
}

export async function speakDecide(f: FormData) {
  await decide(getCtx(), s(f, "id"), Number(s(f, "option")), "dashboard", s(f, "note") || undefined);
  revalidatePath("/speak");
}

export async function speakTest(f: FormData) {
  await escalate(getCtx(), { category: "test", severity: s(f, "severity") as Severity, title: `Test ${s(f, "severity")} escalation`, summary: "This is a test of your escalation policy.", details: "Triggered from BINGO SPEAK.", options: [{ label: "OK", description: "Acknowledge the test" }], recommendation: "No action needed.", source: { kind: "test", id: newId("t") }, verified: true });
  revalidatePath("/speak");
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export async function skillLearn(f: FormData) {
  await learnSkill(getCtx(), s(f, "instruction"));
  revalidatePath("/skills");
}

export async function skillToggle(f: FormData) {
  await updateSkill(getCtx(), s(f, "id"), { status: s(f, "status") as "active" | "disabled" });
  revalidatePath("/skills");
}

export async function skillEdit(f: FormData) {
  const effect = JSON.parse(s(f, "effect"));
  await updateSkill(getCtx(), s(f, "id"), { effect, name: s(f, "name") });
  revalidatePath("/skills");
}

export async function skillRate(f: FormData) {
  await skillFeedback(getCtx(), s(f, "id"), s(f, "text"), Number(s(f, "rating")) as -1 | 0 | 1);
  revalidatePath("/skills");
}
