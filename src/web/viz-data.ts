import type { Ctx, Activity } from "@/core/context";
import type { Approval } from "@/core/policy";
import type { GraphEdge } from "@/core/graph";
import { listConnections } from "@/ai/engine";
import { listProjects } from "@/build/developer";
import { listCreatives } from "@/studio/creative";
import { countryName, listLeads } from "@/global/crm";
import { listMeetings } from "@/calendar/meetings";
import { listSkills } from "@/skills/engine";
import { listWorkflows } from "@/orchestrator/workflow";
import type { Incident } from "@/speak/escalation";
import type { Report } from "@/reports/report";

/**
 * Data for the futuristic visualisations. Everything shown is a real record
 * from BINGO's database — nothing is decorative except the background dust.
 */
export type Tone = "good" | "bad" | "warn" | "info";

export interface VizNode {
  id: string;
  label: string;
  group: string; // module key
  tone: Tone;
  href: string;
}

export interface VizModule {
  key: string;
  label: string;
  href: string;
  count: number;
  good: number;
  bad: number;
}

export interface VizData {
  modules: VizModule[];
  nodes: VizNode[];
  links: [string, string][];
  histogram: { label: string; good: number; bad: number; info: number }[];
  stats: { label: string; value: string }[];
}

const toneOf = (status: string): Tone => {
  if (/^(done|completed|approved|sent|live|confirmed|active|verified|pass|resolved|acknowledged|preview_ready|Active|Agreement|Meeting Confirmed)$/i.test(status)) return "good";
  if (/(fail|error|reject|blocked|cancel|declined|opted|not interested|checks_failed|needs_changes|disqualified)/i.test(status)) return "bad";
  if (/(waiting|awaiting|pending|open|attention|review|paused|draft|proposed|unverified)/i.test(status)) return "warn";
  return "info";
};

export const MODULES: { key: string; label: string; href: string }[] = [
  { key: "global", label: "GLOBAL", href: "/global" },
  { key: "build", label: "BUILD", href: "/build" },
  { key: "studio", label: "STUDIO", href: "/studio" },
  { key: "meetings", label: "MEETINGS", href: "/global" },
  { key: "speak", label: "SPEAK", href: "/speak" },
  { key: "skills", label: "SKILLS", href: "/skills" },
  { key: "workflows", label: "WORKFLOWS", href: "/activity" },
  { key: "approvals", label: "APPROVALS", href: "/" },
  { key: "reports", label: "REPORTS", href: "/activity" },
  { key: "ai", label: "AI ENGINE", href: "/settings#ai" },
];

export async function vizData(ctx: Ctx): Promise<VizData> {
  const [leads, projects, creatives, meetings, skills, workflows, incidents, approvals, reports, ai, edges, activity] = await Promise.all([
    listLeads(ctx),
    listProjects(ctx),
    listCreatives(ctx),
    listMeetings(ctx),
    listSkills(ctx),
    listWorkflows(ctx, 120),
    ctx.store.list<Incident>("incidents", { limit: 60 }),
    ctx.store.list<Approval>("approvals", { limit: 60 }),
    ctx.store.list<Report>("reports", { limit: 40 }),
    listConnections(ctx),
    ctx.store.list<GraphEdge>("kg_edges", { limit: 600 }),
    ctx.store.list<Activity>("activity", { limit: 1500 }),
  ]);

  const nodes: VizNode[] = [];
  const add = (group: string, id: string, label: string, status: string, href: string) => nodes.push({ id, label, group, tone: toneOf(status), href });
  for (const l of leads.slice(0, 160)) add("global", `company:${l.id}`, `${l.company} · ${countryName(l.country)} · ${l.stage}`, l.stage, `/global/${l.id}`);
  for (const p of projects) add("build", `project:${p.id}`, `${p.name} · ${p.status}`, p.status, `/build/${p.id}`);
  for (const c of creatives.slice(0, 60)) add("studio", `creative:${c.id}`, `${c.concept.name} · ${c.status}`, c.status, `/studio/${c.id}`);
  for (const m of meetings) add("meetings", `meeting:${m.id}`, `${m.contact.company || m.contact.name} · ${m.status}`, m.status, "/global");
  for (const i of incidents) add("speak", `incident:${i.id}`, `${i.severity} · ${i.title}`, i.status === "open" ? "open" : i.status, `/speak#${i.id}`);
  for (const s of skills) add("skills", `skill:${s.id}`, `${s.name} · ${s.status}`, s.status, "/skills");
  for (const w of workflows.slice(0, 60)) add("workflows", `workflow:${w.id}`, `${w.goal.slice(0, 60)} · ${w.status}`, w.status, `/workflows/${w.id}`);
  for (const a of approvals.filter((x) => x.status === "pending" || x.status === "rejected")) add("approvals", `approval:${a.id}`, `${a.title} · ${a.status}`, a.status, "/");
  for (const r of reports) add("reports", `report:${r.id}`, `${r.title}`, r.deliveries.some((d) => !d.ok) ? "failed" : "done", `/api/reports/${r.id}`);
  for (const c of ai) add("ai", `ai:${c.id}`, `${c.id} · ${c.lastTest?.ok ? "connected" : "untested"}`, c.lastTest?.ok ? "active" : c.lastTest ? "failed" : "pending", "/settings#ai");

  // Countries become shared hubs linking companies (knowledge-graph edges).
  const ids = new Set(nodes.map((n) => n.id));
  const countries = new Map<string, number>();
  for (const l of leads) countries.set(l.country, (countries.get(l.country) ?? 0) + 1);
  for (const [code, n] of countries) {
    nodes.push({ id: `country:${code}`, label: `${countryName(code)} · ${n} leads`, group: "global", tone: "info", href: `/global?country=${code}` });
    ids.add(`country:${code}`);
  }
  const links: [string, string][] = edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => [e.from, e.to]);
  for (const m of meetings) if (m.leadId && ids.has(`company:${m.leadId}`)) links.push([`meeting:${m.id}`, `company:${m.leadId}`]);

  const modules: VizModule[] = MODULES.map((m) => {
    const own = nodes.filter((n) => n.group === m.key);
    return { ...m, count: own.length, good: own.filter((n) => n.tone === "good").length, bad: own.filter((n) => n.tone === "bad").length };
  });

  // Activity per 2-hour bucket over the last 3 days.
  const now = ctx.now().getTime();
  const buckets = Array.from({ length: 36 }, (_, i) => ({ label: new Date(now - (35 - i) * 2 * 36e5).toISOString().slice(5, 13).replace("T", " "), good: 0, bad: 0, info: 0 }));
  for (const a of activity) {
    const idx = 35 - Math.floor((now - new Date(a.at).getTime()) / (2 * 36e5));
    if (idx < 0 || idx > 35) continue;
    const b = buckets[idx]!;
    if (a.level === "success") b.good++;
    else if (a.level === "error" || a.level === "warning") b.bad++;
    else b.info++;
  }

  const spend = ai.length ? (await ctx.store.list<{ id: string; usd: number; month: string }>("ai_spend")).filter((s) => s.month === ctx.now().toISOString().slice(0, 7)).reduce((a, s) => a + s.usd, 0) : 0;
  const stats = [
    { label: "LEADS", value: String(leads.length) },
    { label: "COUNTRIES", value: String(countries.size) },
    { label: "LIVE SITES", value: String(projects.filter((p) => p.status === "live").length) },
    { label: "CREATIVES", value: String(creatives.length) },
    { label: "MEETINGS", value: String(meetings.filter((m) => m.status === "confirmed").length) },
    { label: "SKILLS", value: String(skills.filter((s) => s.status === "active").length) },
    { label: "PENDING", value: String(approvals.filter((a) => a.status === "pending").length) },
    { label: "AI SPEND", value: `$${spend.toFixed(2)}` },
  ];
  return { modules, nodes, links, histogram: buckets, stats };
}
