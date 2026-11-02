import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { callJson, callResearch } from "@/ai/engine";
import { authorize } from "@/core/policy";
import { getOwner } from "@/core/settings";
import { errorMessage, escapeHtml, newId } from "@/core/util";
import { gmailSend, googleConnected } from "@/integrations/google";
import { pushToSheet } from "@/integrations/sheets-sync";
import { telegramSendDocument } from "@/integrations/telegram";
import { isRtl, languageName, scriptOf } from "@/lang/detect";
import { UNTRUSTED_SYSTEM_RULES, wrapUntrusted } from "@/security/untrusted";
import { STAGES, countryName, listLeads } from "@/global/crm";

/**
 * AI-generated reports: researched facts with sources + connected business data
 * → structured content in the requested language → charts → HTML and PDF →
 * stored → delivered via Gmail / Telegram with real delivery IDs.
 */
const ReportSchema = z.object({
  title: z.string(),
  executiveSummary: z.string(),
  sections: z.array(z.object({ heading: z.string(), body: z.string(), bullets: z.array(z.string()) })),
  dataPoints: z.array(z.object({ label: z.string(), value: z.number(), unit: z.string(), source: z.string() })),
  recommendations: z.array(z.string()),
  risks: z.array(z.string()),
});

export interface Report {
  id: string;
  workspaceId?: string;
  title: string;
  topic: string;
  language: string;
  country?: string;
  content: z.infer<typeof ReportSchema>;
  sources: { url: string; title: string }[];
  crm: { stage: string; count: number }[];
  html: string;
  pdfB64: string | null;
  pdfNote?: string;
  createdAt: string;
  deliveries: { channel: "email" | "telegram"; at: string; ok: boolean; id?: string; detail: string }[];
}

export interface ReportTemplate {
  id: string;
  name: string;
  topic: string;
  country?: string;
  language: string;
  channels: ("email" | "telegram")[];
  schedule: { every: "day" | "week" | "month"; weekday?: number; hour: number };
  lastRunAt?: string;
  enabled: boolean;
}

export async function generateReport(ctx: Ctx, input: { title?: string; topic: string; country?: string; language: string; workspaceId?: string }): Promise<Report> {
  const research = await callResearch(ctx, `${input.topic}${input.country ? ` — focus on ${countryName(input.country)}` : ""}. Cover market size and growth, regulation and product registration requirements, distribution channels, key competitors and distributors, pricing dynamics, risks. Cite sources and give numbers with their year.`, {
    workspaceId: input.workspaceId,
    purpose: "report.research",
    maxUses: 12,
  });
  const leads = (await listLeads(ctx)).filter((l) => !input.country || l.country === input.country);
  const crm = STAGES.map((stage) => ({ stage, count: leads.filter((l) => l.stage === stage).length })).filter((s) => s.count > 0);
  const { data } = await callJson(
    ctx,
    {
      capability: "reasoning",
      system: `You are a senior strategy analyst. Write a decision-ready business report in ${languageName(input.language)} (${input.language}). Use only facts from the research notes and the CRM data; when a fact is uncertain, say so. dataPoints: only numbers stated in the research with their source URL. ${UNTRUSTED_SYSTEM_RULES}`,
      prompt: `Report: ${input.title ?? input.topic}\n\nResearch notes:\n${wrapUntrusted("web-research", research.text).block}\n\nSources:\n${research.sources.map((s) => `- ${s.title}: ${s.url}`).join("\n")}\n\nOur CRM pipeline${input.country ? ` for ${countryName(input.country)}` : ""}: ${crm.map((c) => `${c.stage}: ${c.count}`).join(", ") || "no leads yet"}`,
      effort: "high",
    },
    ReportSchema,
    { workspaceId: input.workspaceId, purpose: "report.write" },
  );
  const report: Report = {
    id: newId("rpt"),
    workspaceId: input.workspaceId,
    title: data.title,
    topic: input.topic,
    language: input.language,
    country: input.country,
    content: data,
    sources: research.sources,
    crm,
    html: "",
    pdfB64: null,
    createdAt: ctx.now().toISOString(),
    deliveries: [],
  };
  report.html = renderReportHtml(report);
  try {
    const pdf = await renderReportPdf(report);
    report.pdfB64 = pdf.b64;
    report.pdfNote = pdf.note;
  } catch (e) {
    report.pdfNote = `PDF not generated: ${errorMessage(e)}. The HTML report is attached instead.`;
  }
  await ctx.store.put("reports", report);
  await pushToSheet(ctx, "reports", [{ "BINGO ID": report.id, Title: report.title, Language: report.language, Created: report.createdAt, "Delivered To": "", File: `${ctx.env.publicUrl}/api/reports/${report.id}` }]);
  await logActivity(ctx, { actor: "bingo", action: "report.generated", summary: `Report ready: ${report.title} (${languageName(report.language)}, ${report.sources.length} sources)`, level: "success", workspaceId: input.workspaceId, ref: { kind: "report", id: report.id } });
  return report;
}

// ---------------------------------------------------------------------------
// Charts (SVG) and HTML
// ---------------------------------------------------------------------------

export function barChartSvg(rows: { label: string; value: number }[], opts: { width?: number; color?: string; unit?: string } = {}): string {
  const W = opts.width ?? 640;
  const barH = 26;
  const gap = 12;
  const labelW = 190;
  const H = rows.length * (barH + gap) + gap;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const bars = rows
    .map((r, i) => {
      const y = gap + i * (barH + gap);
      const w = Math.max(2, ((W - labelW - 70) * r.value) / max);
      return `<text x="${labelW - 10}" y="${y + barH * 0.68}" text-anchor="end" font-size="13" fill="#3b4a56">${escapeHtml(r.label.slice(0, 28))}</text><rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="6" fill="${opts.color ?? "#2FA39A"}"/><text x="${labelW + w + 8}" y="${y + barH * 0.68}" font-size="13" fill="#0b1620">${r.value.toLocaleString("en")}${opts.unit ? ` ${escapeHtml(opts.unit)}` : ""}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Bar chart">${bars}</svg>`;
}

export function renderReportHtml(r: Report): string {
  const rtl = isRtl(r.language);
  const c = r.content;
  const crmChart = r.crm.length ? `<h2>Pipeline</h2>${barChartSvg(r.crm.map((x) => ({ label: x.stage, value: x.count })), { color: "#0F2A3D" })}` : "";
  const byUnit = new Map<string, typeof c.dataPoints>();
  for (const d of c.dataPoints) byUnit.set(d.unit, [...(byUnit.get(d.unit) ?? []), d]);
  const dataCharts = [...byUnit.entries()]
    .filter(([, pts]) => pts.length >= 2)
    .map(([unit, pts]) => `<figure>${barChartSvg(pts.map((p) => ({ label: p.label, value: p.value })), { unit })}<figcaption>${pts.map((p) => escapeHtml(p.source)).filter(Boolean).slice(0, 3).join(" · ")}</figcaption></figure>`)
    .join("");
  return `<!doctype html><html lang="${r.language}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(c.title)}</title>
<style>body{font:16px/1.6 system-ui,-apple-system,"Segoe UI","Noto Sans",sans-serif;color:#0b1620;margin:0;background:#fafbfc}main{max-width:820px;margin:0 auto;padding:48px 24px}h1{font-size:2.2rem;line-height:1.15;margin:.2em 0}h2{margin-top:2.2em;font-size:1.35rem}.meta{color:#5b6b78}.summary{background:#fff;border:1px solid #e3e8ec;border-radius:16px;padding:20px 24px}figure{margin:16px 0;background:#fff;border:1px solid #e3e8ec;border-radius:16px;padding:16px}figcaption{font-size:12px;color:#5b6b78}.sources li{word-break:break-all;font-size:13px}</style></head>
<body><main><p class="meta">BINGO report · ${escapeHtml(languageName(r.language))} · ${r.createdAt.slice(0, 10)}${r.country ? ` · ${escapeHtml(countryName(r.country))}` : ""}</p><h1>${escapeHtml(c.title)}</h1>
<div class="summary"><p>${escapeHtml(c.executiveSummary)}</p></div>
${c.sections.map((s) => `<h2>${escapeHtml(s.heading)}</h2><p>${escapeHtml(s.body)}</p>${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>` : ""}`).join("")}
${dataCharts ? `<h2>Key figures</h2>${dataCharts}` : ""}${crmChart}
${c.recommendations.length ? `<h2>Recommendations</h2><ol>${c.recommendations.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ol>` : ""}
${c.risks.length ? `<h2>Risks</h2><ul>${c.risks.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}
<h2>Sources</h2><ol class="sources">${r.sources.map((s) => `<li><a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a></li>`).join("")}</ol>
</main></body></html>`;
}

// ---------------------------------------------------------------------------
// PDF (pdf-lib + DejaVu Sans: Latin, Cyrillic, Greek)
// ---------------------------------------------------------------------------

const PDF_SCRIPTS = new Set(["Latn", "Cyrl", "Grek"]);

export async function renderReportPdf(r: Report): Promise<{ b64: string | null; note?: string }> {
  if (!PDF_SCRIPTS.has(scriptOf(r.language))) return { b64: null, note: `${languageName(r.language)} needs complex text shaping, which the built-in PDF engine does not support. The report is delivered as HTML (opens in any browser and prints to PDF).` };
  const { PDFDocument, rgb } = await import("pdf-lib");
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const dir = path.join(process.cwd(), "assets", "fonts");
  const regular = await doc.embedFont(await readFile(path.join(dir, "DejaVuSans.ttf")), { subset: true });
  const bold = await doc.embedFont(await readFile(path.join(dir, "DejaVuSans-Bold.ttf")), { subset: true });
  const A4: [number, number] = [595.28, 841.89];
  const M = 56;
  let page = doc.addPage(A4);
  let y = A4[1] - M;
  const ink = rgb(0.04, 0.09, 0.13);
  const muted = rgb(0.36, 0.42, 0.47);
  const write = (text: string, size: number, font = regular, color = ink, after = 6) => {
    const words = text.replace(/\s+/g, " ").split(" ");
    let line = "";
    const lines: string[] = [];
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(t, size) > A4[0] - 2 * M && line) {
        lines.push(line);
        line = w;
      } else line = t;
    }
    if (line) lines.push(line);
    for (const l of lines) {
      if (y < M + size) {
        page = doc.addPage(A4);
        y = A4[1] - M;
      }
      page.drawText(l, { x: M, y: y - size, size, font, color });
      y -= size * 1.45;
    }
    y -= after;
  };
  const c = r.content;
  write(`BINGO · ${r.createdAt.slice(0, 10)}${r.country ? ` · ${countryName(r.country)}` : ""}`, 9, regular, muted, 4);
  write(c.title, 22, bold, ink, 10);
  write(c.executiveSummary, 11, regular, ink, 12);
  for (const s of c.sections) {
    write(s.heading, 14, bold, ink, 4);
    write(s.body, 10.5);
    for (const b of s.bullets) write(`•  ${b}`, 10.5, regular, ink, 2);
    y -= 6;
  }
  if (r.crm.length) {
    write("Pipeline", 14, bold, ink, 6);
    const max = Math.max(...r.crm.map((x) => x.count));
    for (const row of r.crm) {
      if (y < M + 20) {
        page = doc.addPage(A4);
        y = A4[1] - M;
      }
      page.drawText(row.stage, { x: M, y: y - 10, size: 9.5, font: regular, color: ink });
      page.drawRectangle({ x: M + 140, y: y - 12, width: Math.max(2, (260 * row.count) / max), height: 12, color: rgb(0.06, 0.16, 0.24) });
      page.drawText(String(row.count), { x: M + 140 + Math.max(2, (260 * row.count) / max) + 6, y: y - 10, size: 9.5, font: regular, color: ink });
      y -= 20;
    }
    y -= 8;
  }
  if (c.recommendations.length) {
    write("Recommendations", 14, bold, ink, 4);
    c.recommendations.forEach((x, i) => write(`${i + 1}. ${x}`, 10.5, regular, ink, 2));
  }
  if (c.risks.length) {
    write("Risks", 14, bold, ink, 4);
    for (const x of c.risks) write(`•  ${x}`, 10.5, regular, ink, 2);
  }
  write("Sources", 12, bold, ink, 4);
  r.sources.forEach((s, i) => write(`${i + 1}. ${s.title} — ${s.url}`, 8, regular, muted, 1));
  return { b64: Buffer.from(await doc.save()).toString("base64") };
}

export async function deliverReport(ctx: Ctx, reportId: string, channels: ("email" | "telegram")[]) {
  const r = await ctx.store.get<Report>("reports", reportId);
  if (!r) throw new Error("Report not found");
  const owner = await getOwner(ctx);
  const file = r.pdfB64 ? { filename: `${r.title.slice(0, 60)}.pdf`, mime: "application/pdf", data: Buffer.from(r.pdfB64, "base64") } : { filename: `${r.title.slice(0, 60)}.html`, mime: "text/html", data: Buffer.from(r.html, "utf8") };
  const deliveries = [...r.deliveries];
  for (const ch of channels) {
    const at = ctx.now().toISOString();
    try {
      if (ch === "email") {
        if (!owner.email || !(await googleConnected(ctx, r.workspaceId))) throw new Error("Owner email / Gmail not connected");
        const auth = await authorize(ctx, { kind: "email.send.owner", workspaceId: r.workspaceId, payload: { report: r.id, to: owner.email }, title: "Email report to you", summary: r.title, requestedBy: "bingo" });
        if (!auth.allowed) throw new Error(auth.reason);
        const res = await gmailSend(ctx, { to: [owner.email], subject: `BINGO report: ${r.title}`, text: `${r.content.executiveSummary}\n\n${r.pdfNote ?? ""}\n\nOpen in BINGO: ${ctx.env.publicUrl}/api/reports/${r.id}`, attachments: [{ filename: file.filename, mime: file.mime, b64: file.data.toString("base64") }] }, r.workspaceId);
        deliveries.push({ channel: ch, at, ok: true, id: res.id, detail: `submitted to Gmail (${res.id})` });
      } else {
        const auth = await authorize(ctx, { kind: "telegram.notify.owner", payload: { report: r.id }, title: "Send report on Telegram", summary: r.title, requestedBy: "bingo" });
        if (!auth.allowed) throw new Error(auth.reason);
        const res = await telegramSendDocument(ctx, file, `📊 <b>${escapeHtml(r.title)}</b>\n${escapeHtml(r.content.executiveSummary.slice(0, 600))}`);
        deliveries.push("messageId" in res ? { channel: ch, at, ok: true, id: String(res.messageId), detail: `Telegram message ${res.messageId}` } : { channel: ch, at, ok: false, detail: res.skipped });
      }
    } catch (e) {
      deliveries.push({ channel: ch, at, ok: false, detail: errorMessage(e) });
    }
  }
  await ctx.store.put("reports", { ...r, deliveries });
  const ok = deliveries.filter((d) => d.ok && channels.includes(d.channel));
  await pushToSheet(ctx, "reports", [{ "BINGO ID": r.id, Title: r.title, Language: r.language, Created: r.createdAt, "Delivered To": ok.map((d) => `${d.channel}:${d.id}`).join(", "), File: `${ctx.env.publicUrl}/api/reports/${r.id}` }]);
  await logActivity(ctx, { actor: "bingo", action: "report.delivered", summary: `Report “${r.title}”: ${deliveries.slice(-channels.length).map((d) => `${d.channel} ${d.ok ? "✓" : `✗ (${d.detail})`}`).join(", ")}`, level: ok.length === channels.length ? "success" : "warning", ref: { kind: "report", id: r.id } });
  return deliveries.slice(-channels.length);
}

export function templateDue(t: ReportTemplate, now: Date, timeZone: string): boolean {
  if (!t.enabled) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23", weekday: "short", day: "2-digit" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.find((p) => p.type === "weekday")!.value) + 1;
  const day = Number(parts.find((p) => p.type === "day")!.value);
  if (hour < t.schedule.hour) return false;
  if (t.schedule.every === "week" && wd !== (t.schedule.weekday ?? 1)) return false;
  if (t.schedule.every === "month" && day !== 1) return false;
  const last = t.lastRunAt ? new Date(t.lastRunAt) : null;
  return !last || now.getTime() - last.getTime() > 20 * 36e5;
}
