import type { Ctx } from "@/core/context";
import { fetchJson } from "@/core/http";
import type { AdapterCreds, ModelInfo, ProviderAdapter, TextRequest } from "../types";
import { tokenCost } from "./anthropic";

// ---------------------------------------------------------------------------
// OpenAI (official REST API)
// ---------------------------------------------------------------------------

export function openaiAdapter(ctx: Pick<Ctx, "fetch">, opts: { baseUrl?: string; id?: "openai" | "openai-compatible" } = {}): ProviderAdapter {
  const base = (creds: AdapterCreds) => (opts.baseUrl ?? creds.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const headers = (creds: AdapterCreds) => ({
    authorization: `Bearer ${creds.apiKey}`,
    ...(creds.organization ? { "OpenAI-Organization": creds.organization } : {}),
  });

  async function chat(model: ModelInfo, req: TextRequest, creds: AdapterCreds) {
    const content: unknown[] = [{ type: "text", text: req.prompt }];
    for (const img of req.images ?? []) content.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.b64}` } });
    const body: Record<string, unknown> = {
      model: opts.id === "openai-compatible" ? creds.model || model.id : model.id,
      messages: [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content }],
    };
    if (req.jsonSchema) body.response_format = { type: "json_schema", json_schema: { name: "result", schema: req.jsonSchema, strict: true } };
    const res = await fetchJson<{ choices: { message: { content: string; refusal?: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number }; model: string }>(
      ctx,
      `${base(creds)}/chat/completions`,
      { headers: headers(creds), body, timeoutMs: 300_000 },
    );
    const m = res.choices[0]?.message;
    if (m?.refusal) throw new Error(`Model refused: ${m.refusal}`);
    const inputTokens = res.usage?.prompt_tokens ?? 0;
    const outputTokens = res.usage?.completion_tokens ?? 0;
    return { text: m?.content ?? "", usage: { inputTokens, outputTokens, costUsd: tokenCost(model, inputTokens, outputTokens) }, model: res.model ?? model.id };
  }

  function sizeFor(w: number, h: number) {
    const r = w / h;
    if (r > 1.2) return "1536x1024";
    if (r < 0.83) return "1024x1536";
    return "1024x1024";
  }

  return {
    id: opts.id ?? "openai",
    async test(creds) {
      const r = await fetchJson<{ data: { id: string }[] }>(ctx, `${base(creds)}/models`, { headers: headers(creds) });
      const ids = r.data.map((m) => m.id);
      return { ok: true, detail: `Connected. ${ids.length} models visible to this key.`, models: ids };
    },
    text: chat,
    async image(model, req, creds) {
      const r = await fetchJson<{ data: { b64_json: string; revised_prompt?: string }[] }>(ctx, `${base(creds)}/images/generations`, {
        headers: headers(creds),
        body: { model: model.id, prompt: req.prompt, n: req.n ?? 1, size: sizeFor(req.size.width, req.size.height) },
        timeoutMs: 300_000,
      });
      const n = r.data.length;
      return { images: r.data.map((d) => ({ mime: "image/png", b64: d.b64_json })), usage: { images: n, costUsd: n * (model.perImage ?? 0) }, model: model.id, revisedPrompt: r.data[0]?.revised_prompt };
    },
    async editImage(model, req, creds) {
      const form = new FormData();
      form.append("model", model.id);
      form.append("prompt", req.prompt);
      form.append("image", new Blob([Buffer.from(req.image.b64, "base64")], { type: req.image.mime }), "image.png");
      if (req.mask) form.append("mask", new Blob([Buffer.from(req.mask.b64, "base64")], { type: req.mask.mime }), "mask.png");
      const res = await ctx.fetch(`${base(creds)}/images/edits`, { method: "POST", headers: headers(creds), body: form, signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`OpenAI image edit failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      const r = (await res.json()) as { data: { b64_json: string }[] };
      return { images: r.data.map((d) => ({ mime: "image/png", b64: d.b64_json })), usage: { images: r.data.length, costUsd: r.data.length * (model.perImage ?? 0) }, model: model.id };
    },
    async tts(model, req, creds) {
      const res = await ctx.fetch(`${base(creds)}/audio/speech`, {
        method: "POST",
        headers: { ...headers(creds), "content-type": "application/json" },
        body: JSON.stringify({ model: model.id, voice: req.voice ?? "alloy", input: req.text, response_format: "mp3" }),
      });
      if (!res.ok) throw new Error(`OpenAI TTS failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { mime: "audio/mpeg", b64: buf.toString("base64"), usage: { characters: req.text.length, costUsd: (req.text.length / 900) * (model.perMinute ?? 0) }, model: model.id };
    },
  };
}

// ---------------------------------------------------------------------------
// Google Gemini (Generative Language API)
// ---------------------------------------------------------------------------

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType: string; data: string } }[] }; groundingMetadata?: { groundingChunks?: { web?: { uri: string; title?: string } }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
};

export function geminiAdapter(ctx: Pick<Ctx, "fetch">): ProviderAdapter {
  const url = (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const call = (model: ModelInfo, body: unknown, creds: AdapterCreds) =>
    fetchJson<GeminiResponse>(ctx, url(model.id), { headers: { "x-goog-api-key": creds.apiKey! }, body, timeoutMs: 300_000 });
  const usageOf = (model: ModelInfo, r: GeminiResponse) => {
    const i = r.usageMetadata?.promptTokenCount ?? 0;
    const o = r.usageMetadata?.candidatesTokenCount ?? 0;
    return { inputTokens: i, outputTokens: o, costUsd: tokenCost(model, i, o) };
  };
  const textOf = (r: GeminiResponse) => {
    if (r.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request: ${r.promptFeedback.blockReason}`);
    return (r.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  };
  return {
    id: "gemini",
    async test(creds) {
      const r = await fetchJson<{ models: { name: string }[] }>(ctx, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": creds.apiKey! } });
      const ids = r.models.map((m) => m.name.replace(/^models\//, ""));
      return { ok: true, detail: `Connected. ${ids.length} models available.`, models: ids };
    },
    async text(model, req, creds) {
      const parts: unknown[] = [{ text: req.prompt }];
      for (const img of req.images ?? []) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
      const r = await call(
        model,
        {
          ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
          contents: [{ role: "user", parts }],
          generationConfig: req.jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema } : {},
        },
        creds,
      );
      return { text: textOf(r), usage: usageOf(model, r), model: model.id };
    },
    async research(model, query, opts, creds) {
      const r = await call(
        model,
        {
          systemInstruction: { parts: [{ text: `${opts.system ?? ""}\nOnly state facts found via Google Search. Never invent companies, contacts or numbers.` }] },
          contents: [{ role: "user", parts: [{ text: query }] }],
          tools: [{ google_search: {} }],
        },
        creds,
      );
      const chunks = r.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      return { text: textOf(r), sources: chunks.filter((c) => c.web?.uri).map((c) => ({ url: c.web!.uri, title: c.web!.title ?? c.web!.uri })), usage: usageOf(model, r), model: model.id };
    },
    async image(model, req, creds) {
      const r = await call(
        model,
        {
          contents: [{ role: "user", parts: [{ text: `${req.prompt}\nAspect ratio approximately ${req.size.width}:${req.size.height}.` }] }],
          generationConfig: { responseModalities: ["IMAGE"] },
        },
        creds,
      );
      const images = (r.candidates?.[0]?.content?.parts ?? []).filter((p) => p.inlineData).map((p) => ({ mime: p.inlineData!.mimeType, b64: p.inlineData!.data }));
      if (!images.length) throw new Error("Gemini returned no image.");
      return { images, usage: { images: images.length, costUsd: images.length * (model.perImage ?? 0) }, model: model.id };
    },
    async editImage(model, req, creds) {
      const r = await call(
        model,
        {
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: req.image.mime, data: req.image.b64 } }, { text: req.prompt }] }],
          generationConfig: { responseModalities: ["IMAGE"] },
        },
        creds,
      );
      const images = (r.candidates?.[0]?.content?.parts ?? []).filter((p) => p.inlineData).map((p) => ({ mime: p.inlineData!.mimeType, b64: p.inlineData!.data }));
      if (!images.length) throw new Error("Gemini returned no edited image.");
      return { images, usage: { images: images.length, costUsd: images.length * (model.perImage ?? 0) }, model: model.id };
    },
  };
}

// ---------------------------------------------------------------------------
// Translation APIs
// ---------------------------------------------------------------------------

export function googleTranslateAdapter(ctx: Pick<Ctx, "fetch">): ProviderAdapter {
  const base = "https://translation.googleapis.com/language/translate/v2";
  return {
    id: "google-translate",
    async test(creds) {
      const langs = await this.languages!(creds);
      return { ok: true, detail: `Connected. ${langs.length} languages supported.` };
    },
    async languages(creds) {
      const r = await fetchJson<{ data: { languages: { language: string; name?: string }[] } }>(ctx, `${base}/languages?target=en&key=${encodeURIComponent(creds.apiKey!)}`);
      return r.data.languages.map((l) => ({ code: l.language, name: l.name, text: true }));
    },
    async translate(model, req, creds) {
      const r = await fetchJson<{ data: { translations: { translatedText: string; detectedSourceLanguage?: string }[] } }>(ctx, `${base}?key=${encodeURIComponent(creds.apiKey!)}`, {
        body: { q: req.texts, target: req.target, ...(req.source ? { source: req.source } : {}), format: "text" },
      });
      const chars = req.texts.join("").length;
      return {
        texts: r.data.translations.map((t) => t.translatedText),
        detectedSource: r.data.translations[0]?.detectedSourceLanguage,
        usage: { characters: chars, costUsd: (chars / 1_000_000) * (model.perMillionChars ?? 0) },
        model: model.id,
      };
    },
  };
}

export function deeplAdapter(ctx: Pick<Ctx, "fetch">): ProviderAdapter {
  const base = (creds: AdapterCreds) => (creds.apiKey!.endsWith(":fx") ? "https://api-free.deepl.com/v2" : "https://api.deepl.com/v2");
  const auth = (creds: AdapterCreds) => ({ authorization: `DeepL-Auth-Key ${creds.apiKey}` });
  return {
    id: "deepl",
    async test(creds) {
      const langs = await this.languages!(creds);
      return { ok: true, detail: `Connected. ${langs.length} target languages.` };
    },
    async languages(creds) {
      const r = await fetchJson<{ language: string; name: string }[]>(ctx, `${base(creds)}/languages?type=target`, { headers: auth(creds) });
      return r.map((l) => ({ code: l.language.toLowerCase(), name: l.name, text: true }));
    },
    async translate(model, req, creds) {
      const r = await fetchJson<{ translations: { text: string; detected_source_language?: string }[] }>(ctx, `${base(creds)}/translate`, {
        headers: auth(creds),
        body: { text: req.texts, target_lang: req.target.toUpperCase(), ...(req.source ? { source_lang: req.source.toUpperCase().split("-")[0] } : {}) },
      });
      const chars = req.texts.join("").length;
      return {
        texts: r.translations.map((t) => t.text),
        detectedSource: r.translations[0]?.detected_source_language?.toLowerCase(),
        usage: { characters: chars, costUsd: (chars / 1_000_000) * (model.perMillionChars ?? 0) },
        model: model.id,
      };
    },
  };
}
