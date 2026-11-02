import { MemoryStore } from "@/core/store";
import { makeCtx, type Ctx } from "@/core/context";
import type { LandingContent, SiteSpec } from "@/build/landing";
import { carpediemStarterKit } from "@/studio/brand";

export function testCtx(fetchImpl?: typeof fetch, now?: () => Date): Ctx {
  return makeCtx({ store: new MemoryStore(), fetch: fetchImpl ?? (async () => new Response("no network in tests", { status: 599 })), now });
}

export function sampleSpec(over: Partial<SiteSpec> = {}): SiteSpec {
  const kit = carpediemStarterKit(new Date().toISOString());
  return {
    kind: "product",
    name: "SleepTime by Carpediem",
    slug: "carpediem-sleeptime",
    brandName: "Carpediem",
    colors: kit.colors,
    fonts: kit.fonts,
    locales: ["en"],
    sections: ["hero", "benefits", "story", "faq", "form"],
    contactEmail: "hello@example.com",
    leadSource: "landing:sleeptime",
    ...over,
  };
}

export function sampleContent(over: Partial<LandingContent> = {}): LandingContent {
  return {
    seo: { title: "SleepTime by Carpediem — evening ritual", description: "Discover SleepTime, a calm evening ritual from Carpediem, crafted with care and a science-led approach." },
    hero: { eyebrow: "Carpediem", headline: "Your evening, reimagined", subline: "A quieter end to the day, designed with a science-led approach.", primaryCta: "Get in touch", secondaryCta: "Learn more" },
    benefits: [
      { title: "Thoughtfully made", body: "Formulated and presented with Carpediem's clean, considered approach.", claimId: "" },
      { title: "Simple ritual", body: "Built to fit naturally into the last hour of your day.", claimId: "" },
      { title: "Clear information", body: "Everything you need to know, presented plainly.", claimId: "" },
    ],
    story: { title: "Why we made SleepTime", body: "Evenings deserve the same care as mornings.\n\nSleepTime is our answer: calm, precise and honest." },
    comparison: { title: "", columns: [], rows: [] },
    evidence: [],
    faq: [{ q: "How do I order?", a: "Send us a message using the form and our team will reply." }],
    form: {
      title: "Talk to our team",
      intro: "Questions about SleepTime? We usually reply within one business day.",
      submitLabel: "Send message",
      consent: "I agree that Carpediem may contact me about my enquiry.",
      success: "Thank you — we have received your message.",
      fields: [
        { name: "name", label: "Name", type: "text", required: true, options: [] },
        { name: "email", label: "Email", type: "email", required: true, options: [] },
        { name: "message", label: "Message", type: "textarea", required: false, options: [] },
      ],
    },
    privacy: { title: "Privacy notice", body: "We use the details you send only to answer your enquiry.\n\nYou can ask us to delete them at any time." },
    footer: { legal: "All rights reserved.", disclaimer: "" },
    ...over,
  };
}
