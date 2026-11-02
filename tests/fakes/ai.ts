import type { Ctx } from "@/core/context";
import { saveConnection, setAdapterFactory } from "@/ai/engine";
import type { ModelInfo, ProviderAdapter, ProviderId, TextRequest } from "@/ai/types";
import { sampleContent } from "../helpers";

/**
 * Deterministic stand-ins for AI providers. They answer according to the JSON
 * schema requested, so the real BINGO pipelines (validation, compliance,
 * routing, fallback) run unchanged.
 */
export interface FakeAiOptions {
  research?: { text: string; sources: { url: string; title: string }[] };
  candidates?: unknown[];
  emailBody?: (lang: string) => string;
  analysis?: (text: string) => { intent: string; summary: string; requests: string[]; proposedTimes: string[]; sentiment: string };
  concepts?: { headline: string; subline: string; cta: string }[];
  failFirstTextCall?: boolean;
  calls?: { capability: string; system?: string; prompt: string; model: string }[];
  landingOverrides?: Record<string, unknown>;
}

function keys(schema?: Record<string, unknown>) {
  return Object.keys((schema?.properties as object) ?? {});
}

export function fakeText(o: FakeAiOptions, model: ModelInfo, req: TextRequest): string {
  o.calls?.push({ capability: req.capability, system: req.system, prompt: req.prompt, model: model.id });
  const k = keys(req.jsonSchema);
  if (k.includes("concepts")) {
    const list = o.concepts ?? [
      { headline: "Quiet evenings, beautifully made", subline: "A calm evening ritual from Carpediem, presented with a science-led approach.", cta: "Discover" },
      { headline: "The art of slowing down", subline: "Considered design for the last hour of your day.", cta: "Learn more" },
      { headline: "Designed for your night", subline: "Clean, premium and honest — the Carpediem way.", cta: "Explore" },
      { headline: "Evening, refined", subline: "Simple ritual. Thoughtful details.", cta: "See more" },
      { headline: "Rest, by design", subline: "Premium wellness, presented with care.", cta: "Discover" },
    ];
    return JSON.stringify({ concepts: list.map((c, i) => ({ name: `Concept ${i + 1}`, angle: "premium calm", imagePrompt: "soft morning light on a linen surface, minimal, airy", claimIds: [], ...c })) });
  }
  if (k.includes("seo") && k.includes("hero")) {
    const lang = req.prompt.match(/Write in language: ([\w-]+)/)?.[1] ?? "en";
    const c = sampleContent();
    if (lang === "ru") c.hero.headline = "Станьте нашим партнёром";
    return JSON.stringify({ ...c, ...(o.landingOverrides ?? {}) });
  }
  if (k.includes("candidates")) return JSON.stringify({ candidates: o.candidates ?? [] });
  if (k.includes("relevance")) return JSON.stringify({ relevance: 78, portfolioFit: "Distributes OTC and supplements through pharmacies nationwide.", risks: "" });
  if (k.includes("subject") && k.includes("personalization")) {
    const lang = req.system?.match(/natively in .*?\(([\w-]+)\)/)?.[1] ?? "en";
    return JSON.stringify({ subject: lang === "ru" ? "Сотрудничество с Carpediem" : "Partnership with Carpediem", body: o.emailBody?.(lang) ?? (lang === "ru" ? "Здравствуйте! Мы — компания Carpediem. Будем рады обсудить возможное сотрудничество с вашей компанией. Удобно ли вам провести короткий звонок?" : "Hello! We are Carpediem. We would be glad to discuss a possible partnership. Would a short call suit you?"), personalization: "Mentioned their pharmacy network." });
  }
  if (k.includes("intent") && k.includes("sentiment")) {
    const text = req.prompt;
    return JSON.stringify(o.analysis?.(text) ?? (/эксклюзив|exclusiv/i.test(text) ? { intent: "exclusivity_request", summary: "They ask for exclusive distribution rights for Uzbekistan.", requests: ["exclusive rights"], proposedTimes: [], sentiment: "positive" } : /встреч|call|meet|созвон/i.test(text) ? { intent: "meeting_request", summary: "They would like to schedule a call.", requests: [], proposedTimes: [], sentiment: "positive" } : { intent: "interested", summary: "They are interested.", requests: [], proposedTimes: [], sentiment: "positive" }));
  }
  if (k.includes("chosenOption")) {
    const m = req.prompt.match(/(?:вариант|option)\s*(\d)/i);
    return JSON.stringify({ chosenOption: m ? Number(m[1]) : 0, alternativeIso: "", declined: false, explanation: "Picked an option" });
  }
  if (k.includes("objective") && k.includes("questions")) return JSON.stringify({ objective: "Explore distribution in Uzbekistan", previousCommunications: "Intro sent; they replied positively.", opportunity: "Nationwide pharmacy coverage", documents: ["Company profile"], questions: ["Which channels?", "Current brands?"], commitments: [], nextSteps: ["Send company profile"] });
  if (k.includes("executiveSummary")) return JSON.stringify({ title: req.prompt.includes("Cambodia") ? "Cambodia expansion report" : "Market report", executiveSummary: "Cambodia's pharmacy market is growing; registration is required for imported supplements.", sections: [{ heading: "Market", body: "The market grew in 2025 according to sources.", bullets: ["Growing pharmacy chains"] }], dataPoints: [{ label: "2024", value: 100, unit: "USD m", source: "https://example.org/a" }, { label: "2025", value: 112, unit: "USD m", source: "https://example.org/a" }], recommendations: ["Shortlist three distributors"], risks: ["Registration timelines"] });
  if (k.includes("translations")) {
    const arr = JSON.parse(req.prompt.slice(req.prompt.indexOf("["))) as string[];
    return JSON.stringify({ translations: arr.map((s) => `«${s}»`) });
  }
  if (k.includes("steps") && k.includes("clarification")) return JSON.stringify({ steps: [], clarification: "Please specify the country." });
  return JSON.stringify({});
}

export function fakeAdapters(o: FakeAiOptions = {}) {
  let failed = false;
  return (_ctx: Ctx, id: ProviderId): ProviderAdapter => {
    if (id === "openai")
      return {
        id,
        test: async () => ({ ok: true, detail: "ok" }),
        image: async (m) => ({ images: [{ mime: "image/png", b64: Buffer.from(`png-${Math.random()}`).toString("base64") }], usage: { images: 1, costUsd: m.perImage ?? 0.04 }, model: m.id }),
        editImage: async (m) => ({ images: [{ mime: "image/png", b64: Buffer.from("edited").toString("base64") }], usage: { images: 1, costUsd: 0.04 }, model: m.id }),
      };
    if (id === "google-translate")
      return {
        id,
        test: async () => ({ ok: true, detail: "ok" }),
        languages: async () => ["en", "ru", "uz", "tg", "ky", "tk", "km", "lo", "ar", "hi", "ne"].map((code) => ({ code, text: true })),
        translate: async (m, req) => ({ texts: req.texts.map((t) => (req.target === "en" ? `[en] ${t}` : `[${req.target}] ${t}`)), detectedSource: req.source, usage: { characters: req.texts.join("").length, costUsd: 0.0001 }, model: m.id }),
      };
    return {
      id,
      test: async () => ({ ok: true, detail: "Connected.", models: ["claude-opus-5-5"] }),
      text: async (m, req) => {
        if (o.failFirstTextCall && !failed) {
          failed = true;
          throw new Error("simulated outage");
        }
        return { text: fakeText(o, m, req), usage: { inputTokens: 1000, outputTokens: 500, costUsd: ((m.inputPer1M ?? 0) * 1000 + (m.outputPer1M ?? 0) * 500) / 1e6 }, model: m.id };
      },
      research: async (m) => ({ text: o.research?.text ?? "No results", sources: o.research?.sources ?? [], usage: { costUsd: 0.05 }, model: m.id }),
      toolLoop: async (m, req) => {
        const r = await req.runTool("run_checks", {});
        return { finalText: `Checks: ${r.content}`, turns: 1, usage: { costUsd: 0.01 }, model: m.id, stoppedBecause: "done" };
      },
    };
  };
}

export async function connectFakeAi(ctx: Ctx, o: FakeAiOptions = {}, providers: ProviderId[] = ["anthropic", "openai", "google-translate"]) {
  setAdapterFactory(fakeAdapters(o));
  for (const p of providers) await saveConnection(ctx, p, { credentials: { apiKey: `test-${p}-key-123456` } });
}
