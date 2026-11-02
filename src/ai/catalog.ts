import type { Capability, ProviderDescriptor, ProviderId } from "./types";

/**
 * Provider marketplace. Anthropic prices are Anthropic's published API rates.
 * Other providers' prices are marked "estimate": the owner should confirm them
 * in Settings → AI Models because they change and depend on the account.
 * Model lists are refreshed from each provider's model-listing API on "Test".
 */
export const PROVIDERS: ProviderDescriptor[] = [
  {
    id: "anthropic",
    name: "Anthropic Claude",
    summary: "Reasoning, research with web search, software development, multilingual writing, complex workflows.",
    docsUrl: "https://platform.claude.com/docs",
    credentialFields: [{ key: "apiKey", label: "API key", secret: true, placeholder: "sk-ant-…" }],
    models: [
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        capabilities: ["reasoning", "coding", "copywriting", "translation", "research", "vision", "classification"],
        quality: 0.97,
        inputPer1M: 4,
        outputPer1M: 20,
        latencyMs: 9000,
        priceSource: "published",
      },
      {
        id: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        capabilities: ["reasoning", "coding", "copywriting", "translation", "research", "vision", "classification"],
        quality: 0.92,
        inputPer1M: 2,
        outputPer1M: 10,
        latencyMs: 5000,
        priceSource: "published",
      },
      {
        id: "claude-haiku-5-5",
        label: "Claude Haiku 5.5",
        capabilities: ["classification", "translation", "copywriting", "vision"],
        quality: 0.8,
        inputPer1M: 0.1,
        outputPer1M: 0.5,
        latencyMs: 1500,
        priceSource: "published",
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    summary: "Text models, image generation & editing, text-to-speech and transcription.",
    docsUrl: "https://platform.openai.com/docs",
    credentialFields: [
      { key: "apiKey", label: "API key", secret: true, placeholder: "sk-…" },
      { key: "organization", label: "Organization ID", secret: false, optional: true },
    ],
    models: [
      { id: "gpt-5", label: "GPT-5 (text)", capabilities: ["reasoning", "coding", "copywriting", "translation", "classification", "vision"], quality: 0.9, inputPer1M: 1.25, outputPer1M: 10, latencyMs: 7000, priceSource: "estimate" },
      { id: "gpt-image-1", label: "GPT Image (generate & edit)", capabilities: ["image.generate", "image.edit"], quality: 0.9, perImage: 0.17, latencyMs: 30000, priceSource: "estimate" },
      { id: "gpt-4o-mini-tts", label: "TTS", capabilities: ["speech.tts"], quality: 0.85, perMinute: 0.015, latencyMs: 3000, priceSource: "estimate" },
      { id: "gpt-4o-transcribe", label: "Transcribe", capabilities: ["speech.stt"], quality: 0.88, perMinute: 0.006, latencyMs: 4000, priceSource: "estimate" },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    summary: "Multimodal analysis, grounded Google Search research, image generation.",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    credentialFields: [{ key: "apiKey", label: "API key", secret: true }],
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", capabilities: ["reasoning", "coding", "copywriting", "translation", "research", "vision", "classification"], quality: 0.88, inputPer1M: 1.25, outputPer1M: 10, latencyMs: 8000, priceSource: "estimate" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", capabilities: ["classification", "translation", "copywriting", "research", "vision"], quality: 0.78, inputPer1M: 0.3, outputPer1M: 2.5, latencyMs: 2500, priceSource: "estimate" },
      { id: "gemini-2.5-flash-image", label: "Gemini image", capabilities: ["image.generate", "image.edit"], quality: 0.85, perImage: 0.04, latencyMs: 15000, priceSource: "estimate" },
    ],
  },
  {
    id: "google-translate",
    name: "Google Cloud Translation",
    summary: "Machine translation for 100+ languages; language list discovered from the API.",
    docsUrl: "https://cloud.google.com/translate/docs",
    credentialFields: [{ key: "apiKey", label: "API key", secret: true }],
    models: [{ id: "nmt", label: "Translation v2 (NMT)", capabilities: ["translation"], quality: 0.8, perMillionChars: 20, latencyMs: 600, priceSource: "estimate" }],
  },
  {
    id: "deepl",
    name: "DeepL",
    summary: "High-quality translation for the languages DeepL supports (discovered from the API).",
    docsUrl: "https://developers.deepl.com/docs",
    credentialFields: [{ key: "apiKey", label: "Auth key", secret: true, placeholder: "…:fx for the free plan" }],
    models: [{ id: "deepl", label: "DeepL API", capabilities: ["translation"], quality: 0.86, perMillionChars: 25, latencyMs: 700, priceSource: "estimate" }],
  },
  {
    id: "openai-compatible",
    name: "Other model (OpenAI-compatible API)",
    summary: "Connect a future or self-hosted model that exposes an OpenAI-compatible chat endpoint.",
    docsUrl: "https://platform.openai.com/docs/api-reference/chat",
    credentialFields: [
      { key: "baseUrl", label: "Base URL", secret: false, placeholder: "https://example.com/v1" },
      { key: "apiKey", label: "API key", secret: true },
      { key: "model", label: "Model name", secret: false },
    ],
    models: [{ id: "custom", label: "Custom model", capabilities: ["copywriting", "classification", "translation"], quality: 0.6, inputPer1M: 1, outputPer1M: 2, latencyMs: 5000, priceSource: "estimate" }],
  },
];

export function descriptor(id: ProviderId): ProviderDescriptor {
  const d = PROVIDERS.find((p) => p.id === id);
  if (!d) throw new Error(`Unknown provider ${id}`);
  return d;
}

/** Which providers *could* supply a capability — used to explain what is missing. */
export function providersFor(cap: Capability): ProviderDescriptor[] {
  return PROVIDERS.filter((p) => p.models.some((m) => m.capabilities.includes(cap)));
}

/** Default preference order of capability → model for a fresh connection. */
export const SUGGESTED_DEFAULTS: Partial<Record<ProviderId, Partial<Record<Capability, string>>>> = {
  anthropic: {
    reasoning: "claude-opus-5-5",
    coding: "claude-opus-5-5",
    research: "claude-opus-5-5",
    copywriting: "claude-opus-5-5",
    translation: "claude-sonnet-5-5",
    vision: "claude-opus-5-5",
    classification: "claude-haiku-5-5",
  },
  openai: { "image.generate": "gpt-image-1", "image.edit": "gpt-image-1", "speech.tts": "gpt-4o-mini-tts", "speech.stt": "gpt-4o-transcribe" },
  gemini: { "image.generate": "gemini-2.5-flash-image", "image.edit": "gemini-2.5-flash-image", research: "gemini-2.5-pro" },
};
