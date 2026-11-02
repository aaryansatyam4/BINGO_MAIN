import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { callJson, callText, explainMissing, route, saveConnection, setAdapterFactory, testConnection, toProviderSchema, withUsageScope } from "@/ai/engine";
import { anthropicAdapter } from "@/ai/providers/anthropic";
import { CapabilityUnavailableError } from "@/ai/types";
import { connectFakeAi } from "./fakes/ai";
import { testCtx } from "./helpers";

afterEach(() => setAdapterFactory(null));

describe("BINGO AI ENGINE routing", () => {
  it("routes by capability: coding → Claude, images → image provider, translation → translation API first", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx);
    expect((await route(ctx, "coding"))[0]).toMatchObject({ provider: "anthropic", model: { id: "claude-opus-5-5" } });
    expect((await route(ctx, "image.generate"))[0]?.provider).toBe("openai");
    expect((await route(ctx, "classification"))[0]?.model.id).toBe("claude-haiku-5-5");
    const tr = await route(ctx, "translation");
    expect(tr.map((c) => c.provider)).toContain("google-translate");
  });

  it("explains which provider is needed instead of pretending", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx, {}, ["anthropic"]);
    await expect(callText(ctx, { capability: "image.generate", prompt: "x" }, { purpose: "t" })).rejects.toBeInstanceOf(CapabilityUnavailableError);
    expect(await explainMissing(ctx, "image.generate")).toMatch(/OpenAI|Gemini/);
    expect(await explainMissing(ctx, "speech.tts")).toMatch(/Settings → AI Models/);
  });

  it("falls back to the next model when one fails and records reliability", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx, { failFirstTextCall: true }, ["anthropic"]);
    const r = await callJson(ctx, { capability: "reasoning", prompt: "x" }, z.object({}), { purpose: "t" });
    expect(r.modelId).not.toBe("claude-opus-5-5"); // first choice failed → fallback
    const second = await route(ctx, "reasoning");
    expect(second[0]!.reasons.join(" ")).toMatch(/reliability/);
  });

  it("enforces monthly spending limits and workspace restrictions", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx, {}, ["anthropic"]);
    await saveConnection(ctx, "anthropic", { monthlyLimitUsd: 0.0001 });
    await callText(ctx, { capability: "reasoning", prompt: "x" }, { purpose: "t" });
    expect(await route(ctx, "reasoning")).toEqual([]);
    expect(await explainMissing(ctx, "reasoning")).toMatch(/spending limit/);
    await saveConnection(ctx, "anthropic", { monthlyLimitUsd: 100, allowedWorkspaces: ["ws_isshaan"] });
    expect(await route(ctx, "reasoning", { workspaceId: "ws_carpediem" })).toEqual([]);
    expect((await route(ctx, "reasoning", { workspaceId: "ws_isshaan" })).length).toBeGreaterThan(0);
  });

  it("tracks usage per scope (shown per workflow step)", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx, {}, ["anthropic"]);
    const { usage } = await withUsageScope(() => callText(ctx, { capability: "reasoning", prompt: "x" }, { purpose: "t" }));
    expect(usage.calls).toBe(1);
    expect(usage.costUsd).toBeCloseTo((4 * 1000 + 20 * 500) / 1e6);
  });

  it("tests connections and stores the result", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx, {}, ["anthropic"]);
    expect(await testConnection(ctx, "anthropic")).toMatchObject({ ok: true });
  });

  it("converts zod schemas to strict provider JSON schemas", () => {
    const s = toProviderSchema(z.object({ a: z.string().min(2), b: z.array(z.object({ c: z.number() })) }));
    expect(s).toMatchObject({ type: "object", additionalProperties: false, required: ["a", "b"] });
    expect(JSON.stringify(s)).not.toMatch(/minLength|\$schema/);
  });
});

describe("Anthropic adapter request shape", () => {
  it("uses the official SDK with structured output, effort and server-side fallbacks", async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchFake = (async (url: string, init: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      seen.push({ url: String(url), headers, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: '{"ok":true}' }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const a = anthropicAdapter({ fetch: fetchFake });
    const model = { id: "claude-opus-5-5", label: "", capabilities: [], quality: 1, inputPer1M: 4, outputPer1M: 20, latencyMs: 1, priceSource: "published" as const };
    const r = await a.text!(model, { capability: "reasoning", system: "sys", prompt: "hi", jsonSchema: { type: "object", properties: {}, additionalProperties: false, required: [] }, effort: "high" }, { apiKey: "sk-ant-test" });
    expect(r.text).toBe('{"ok":true}');
    expect(r.usage.costUsd).toBeCloseTo((10 * 4 + 5 * 20) / 1e6);
    const req = seen[0]!;
    expect(req.url).toContain("/v1/messages");
    expect(req.headers["x-api-key"] ?? req.headers.authorization?.replace("Bearer ", "")).toBe("sk-ant-test");
    expect(req.headers["anthropic-version"]).toBeTruthy();
    expect(req.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(req.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "high", format: { type: "json_schema" } } });
    expect(req.body).not.toHaveProperty("temperature");
    expect(req.body).not.toHaveProperty("thinking");
  });

  it("collects web-search sources and handles refusals", async () => {
    let n = 0;
    const fetchFake = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      n++;
      if (body.tools) {
        expect(body.tools[0]).toMatchObject({ type: "web_search_20260209", name: "web_search" });
        return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "web_search_tool_result", tool_use_id: "x", content: [{ type: "web_search_result", url: "https://pharma.uz", title: "Pharma UZ" }] }, { type: "text", text: "Pharma UZ is a distributor.", citations: [{ type: "web_search_result_location", url: "https://pharma.uz", title: "Pharma UZ" }] }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 2 } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "no" }, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const a = anthropicAdapter({ fetch: fetchFake });
    const model = { id: "claude-opus-5-5", label: "", capabilities: [], quality: 1, inputPer1M: 4, outputPer1M: 20, latencyMs: 1, priceSource: "published" as const };
    const r = await a.research!(model, "find distributors", { maxUses: 3 }, { apiKey: "k" });
    expect(r.sources).toEqual([{ url: "https://pharma.uz", title: "Pharma UZ" }]);
    expect(r.usage.costUsd).toBeGreaterThanOrEqual(0.02);
    await expect(a.text!(model, { capability: "reasoning", prompt: "x" }, { apiKey: "k" })).rejects.toThrow(/declined/);
    expect(n).toBe(2);
  });
});
