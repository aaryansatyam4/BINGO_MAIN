/**
 * Catalogue of everything the orchestrator can do. Skills and AI-composed plans
 * may only reference these step types, intents and events — they cannot invent
 * new executable behaviour. New executable code goes through BINGO BUILD and
 * explicit activation approval.
 */
export interface StepTypeInfo {
  label: string;
  module: "build" | "studio" | "global" | "calendar" | "speak" | "skills" | "reports" | "notify" | "tasks" | "lang";
  params: string[]; // allowed parameter names
  external: boolean; // has side effects outside BINGO
}

export const STEP_TYPES: Record<string, StepTypeInfo> = {
  "build.plan": { label: "Understand request & plan the site", module: "build", params: ["request", "kind", "locales", "productId", "workspaceId", "brandKitId"], external: false },
  "build.content": { label: "Write approved copy & translations", module: "build", params: ["projectId", "market"], external: false },
  "build.files": { label: "Generate code & assets", module: "build", params: ["projectId"], external: false },
  "build.checks": { label: "Security scan, typecheck, build & tests (sandbox)", module: "build", params: ["projectId"], external: false },
  "build.github": { label: "Commit to GitHub & open PR", module: "build", params: ["projectId"], external: true },
  "build.preview": { label: "Deploy Vercel preview & verify", module: "build", params: ["projectId"], external: true },
  "build.production": { label: "Publish to production (approval)", module: "build", params: ["projectId"], external: true },
  "studio.generate": { label: "Generate creatives", module: "studio", params: ["brief", "count", "formats", "productId", "brandKitId", "workspaceId", "language", "market"], external: false },
  "global.research": { label: "Research & verify distributors", module: "global", params: ["country", "count", "segment", "workspaceId"], external: false },
  "global.draft": { label: "Draft personalised emails", module: "global", params: ["leadIds", "language", "kind", "purpose", "extra"], external: false },
  "global.send": { label: "Approve & send emails via Gmail", module: "global", params: ["messageIds"], external: true },
  "global.share_page": { label: "Draft emails sharing the live page", module: "global", params: ["projectId", "leadIds", "language"], external: false },
  "calendar.propose": { label: "Propose meeting times", module: "calendar", params: ["leadIds", "objective", "durationMin"], external: false },
  "report.generate": { label: "Research, analyse & write report", module: "reports", params: ["title", "topic", "country", "language", "workspaceId"], external: false },
  "report.deliver": { label: "Deliver report (Gmail / Telegram)", module: "reports", params: ["reportId", "channels"], external: true },
  "notify.telegram": { label: "Telegram message to you", module: "notify", params: ["text"], external: true },
  "notify.email": { label: "Email to you", module: "notify", params: ["subject", "text"], external: true },
  "tasks.create": { label: "Create task in company sheet", module: "tasks", params: ["ref", "kind", "title", "details", "to", "level", "deadlineDays"], external: true },
  "speak.policy": { label: "Update escalation policy", module: "speak", params: ["instruction"], external: false },
  "skills.learn": { label: "Save reusable skill", module: "skills", params: ["instruction"], external: false },
};

export const INTENTS = ["build.landing", "studio.creatives", "global.research", "global.outreach", "calendar.schedule", "report.create", "speak.policy", "skills.learn", "global.share_page"] as const;
export type Intent = (typeof INTENTS)[number];

export const EVENTS = ["meeting.confirmed", "deployment.production.live", "deployment.preview.ready", "product.launched", "lead.inbound", "reply.received", "report.delivered"] as const;
export type BingoEvent = (typeof EVENTS)[number];

export interface StepTemplate {
  type: string;
  title?: string;
  params: Record<string, unknown>;
}
