import { createHmac, timingSafeEqual } from "node:crypto";
import { getCtx, logActivity } from "@/core/context";
import { escapeHtml } from "@/core/util";
import { getProject } from "@/build/developer";
import { countryCode, findDuplicate, newLead, saveLead, syncLeadsToSheet } from "@/global/crm";
import { createCompanyTask } from "@/integrations/tasks";
import { telegramSend } from "@/integrations/telegram";
import { detectLanguage } from "@/lang/detect";

export const dynamic = "force-dynamic";

/** Signed lead submissions from BINGO-built websites → CRM → Google Sheets → task → notification. */
export async function POST(req: Request) {
  const ctx = getCtx();
  const projectId = new URL(req.url).searchParams.get("project") ?? "";
  const project = await getProject(ctx, projectId);
  if (!project) return Response.json({ ok: false }, { status: 404 });
  const secret = await ctx.vault.get(project.workspaceId, `lead_secret:${project.id}`);
  const body = await req.text();
  const sig = req.headers.get("x-bingo-signature") ?? "";
  const expected = secret ? createHmac("sha256", secret).update(body).digest("hex") : "";
  if (!secret || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return Response.json({ ok: false }, { status: 401 });
  const data = JSON.parse(body) as { fields: Record<string, string>; locale: string; source: string };
  const f = data.fields;
  const country = (f.country && countryCode(f.country)) || "";
  const company = f.company || f.name || f.email;
  const dup = await findDuplicate(ctx, { company, country: country || "XX", website: f.website, emails: [{ address: f.email }] }, project.workspaceId);
  const text = [f.portfolio, f.message].filter(Boolean).join("\n");
  const lead = dup ?? newLead(ctx, { workspaceId: project.workspaceId, company, country: country || "XX", website: f.website ?? "", origin: "website_form", stage: "Replied", segment: project.kind });
  lead.emails = lead.emails.some((e) => e.address === f.email) ? lead.emails : [{ address: f.email, source: "form", verified: true, note: "submitted via website form" }, ...lead.emails];
  if (f.phone) lead.phones = [...new Set([f.phone, ...lead.phones])];
  if (f.name) lead.contacts = [{ name: f.name, role: "", email: f.email }, ...lead.contacts.filter((c) => c.email !== f.email)];
  lead.description = [lead.description, text].filter(Boolean).join("\n").slice(0, 4000);
  lead.language = data.locale || (text ? detectLanguage(text).language : lead.language);
  lead.languageSource = "detected";
  lead.notes = [lead.notes, `Form on ${project.name} (${data.locale})`].filter(Boolean).join("\n");
  await saveLead(ctx, lead);
  await syncLeadsToSheet(ctx, [lead]);
  const task = await createCompanyTask(ctx, { ref: `lead:${lead.id}:inbound`, kind: "distributor_followup", title: `New ${project.kind} enquiry: ${company}${country ? ` (${country})` : ""}`, details: `From ${f.name ?? ""} <${f.email}> via ${project.name}.\n${text}`, deadline: new Date(Date.now() + 864e5), level: 2 }, "website", project.workspaceId);
  await telegramSend(ctx, `📥 <b>New enquiry</b> from ${escapeHtml(company)}${country ? ` (${country})` : ""} via ${escapeHtml(project.name)}\n${escapeHtml(f.email)}`).catch(() => undefined);
  await logActivity(ctx, { actor: "website", action: "lead.inbound", summary: `New enquiry from ${company} via ${project.name} (task: ${task.status})`, level: "success", workspaceId: project.workspaceId, ref: { kind: "lead", id: lead.id } });
  const { emitEvent } = await import("@/skills/engine");
  await emitEvent(ctx, "lead.inbound", { id: lead.id, name: company, company, country, summary: `New enquiry from ${company}`, workspaceId: project.workspaceId });
  return Response.json({ ok: true });
}
