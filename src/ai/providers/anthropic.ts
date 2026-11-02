import Anthropic from "@anthropic-ai/sdk";
import type { Ctx } from "@/core/context";
import type { AdapterCreds, ModelInfo, ProviderAdapter, ResearchResult, TextRequest, TextResult, ToolLoopRequest, ToolLoopResult, Usage } from "../types";
import { ModelRefusalError } from "../types";

export function tokenCost(model: ModelInfo, input = 0, output = 0): number {
  return ((model.inputPer1M ?? 0) * input + (model.outputPer1M ?? 0) * output) / 1_000_000;
}

/** Models that accept the server-side refusal fallback parameter. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"]);

type AnyBlock = { type: string; [k: string]: unknown };

export function anthropicAdapter(ctx: Pick<Ctx, "fetch">): ProviderAdapter {
  const client = (creds: AdapterCreds) => new Anthropic({ apiKey: creds.apiKey, fetch: ctx.fetch, maxRetries: 1, timeout: 600_000 });

  function extras(model: ModelInfo) {
    return FALLBACK_MODELS.has(model.id) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : { betas: [] as string[] };
  }

  function usageOf(model: ModelInfo, u: { input_tokens?: number | null; output_tokens?: number | null } | undefined): Usage {
    const inputTokens = u?.input_tokens ?? 0;
    const outputTokens = u?.output_tokens ?? 0;
    return { inputTokens, outputTokens, costUsd: tokenCost(model, inputTokens, outputTokens) };
  }

  function checkRefusal(res: { stop_reason?: string | null; stop_details?: unknown }) {
    if (res.stop_reason === "refusal") {
      const d = res.stop_details as { category?: string; explanation?: string } | null | undefined;
      throw new ModelRefusalError(`The model declined this request${d?.category ? ` (${d.category})` : ""}${d?.explanation ? `: ${d.explanation}` : ""}.`);
    }
  }

  const textOf = (content: AnyBlock[]) =>
    content
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("");

  return {
    id: "anthropic",

    async test(creds) {
      const list = await client(creds).models.list({ limit: 50 });
      const ids = list.data.map((m) => m.id);
      return { ok: true, detail: `Connected. ${ids.length} models available.`, models: ids };
    },

    async text(model, req: TextRequest, creds): Promise<TextResult> {
      const content: AnyBlock[] = [];
      for (const img of req.images ?? []) content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.b64 } });
      content.push({ type: "text", text: req.prompt });
      const res = await client(creds).beta.messages.create({
        model: model.id,
        max_tokens: req.maxTokens ?? 16000,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: "user", content: content as never }],
        output_config: {
          ...(req.effort ? { effort: req.effort } : {}),
          ...(req.jsonSchema ? { format: { type: "json_schema", schema: req.jsonSchema } } : {}),
        },
        ...extras(model),
      } as never);
      const msg = res as unknown as { content: AnyBlock[]; stop_reason: string; stop_details?: unknown; usage: { input_tokens: number; output_tokens: number }; model: string };
      checkRefusal(msg);
      return { text: textOf(msg.content), usage: usageOf(model, msg.usage), model: msg.model ?? model.id };
    },

    async research(model, query, opts, creds): Promise<ResearchResult> {
      const messages: { role: "user" | "assistant"; content: unknown }[] = [{ role: "user", content: query }];
      const sources = new Map<string, string>();
      let text = "";
      const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      let searches = 0;
      for (let turn = 0; turn < 4; turn++) {
        const res = (await client(creds).beta.messages.create({
          model: model.id,
          max_tokens: 16000,
          system:
            (opts.system ?? "") +
            "\nYou research companies and markets using web search. Only state facts you found in sources. Never invent companies, contacts or numbers. Cite the URL for every company you mention.",
          messages: messages as never,
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: opts.maxUses }] as never,
          output_config: { effort: "high" },
          ...extras(model),
        } as never)) as unknown as { content: AnyBlock[]; stop_reason: string; stop_details?: unknown; usage: { input_tokens: number; output_tokens: number; server_tool_use?: { web_search_requests?: number } } };
        checkRefusal(res);
        const u = usageOf(model, res.usage);
        usage.inputTokens! += u.inputTokens!;
        usage.outputTokens! += u.outputTokens!;
        usage.costUsd += u.costUsd;
        searches += res.usage.server_tool_use?.web_search_requests ?? 0;
        for (const b of res.content) {
          if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
            for (const r of b.content as { url?: string; title?: string }[]) if (r.url) sources.set(r.url, r.title ?? r.url);
          }
          if (b.type === "text") {
            text += String(b.text ?? "");
            for (const c of (b.citations as { url?: string; title?: string }[] | undefined) ?? []) if (c.url) sources.set(c.url, c.title ?? c.url);
          }
        }
        if (res.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: res.content });
      }
      usage.costUsd += searches * 0.01; // published web search price: $10 per 1,000 searches
      return { text, sources: [...sources].map(([url, title]) => ({ url, title })), usage, model: model.id };
    },

    async toolLoop(model, req: ToolLoopRequest, creds): Promise<ToolLoopResult> {
      const tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, strict: true }));
      const messages: { role: "user" | "assistant"; content: unknown }[] = [{ role: "user", content: req.prompt }];
      const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      let finalText = "";
      for (let turn = 1; turn <= req.maxTurns; turn++) {
        const res = (await client(creds).beta.messages.create({
          model: model.id,
          max_tokens: 16000,
          system: req.system,
          tools: tools as never,
          messages: messages as never,
          output_config: { effort: "high" },
          ...extras(model),
        } as never)) as unknown as { content: AnyBlock[]; stop_reason: string; stop_details?: unknown; usage: { input_tokens: number; output_tokens: number } };
        const u = usageOf(model, res.usage);
        usage.inputTokens! += u.inputTokens!;
        usage.outputTokens! += u.outputTokens!;
        usage.costUsd += u.costUsd;
        if (res.stop_reason === "refusal") return { finalText: textOf(res.content), turns: turn, usage, model: model.id, stoppedBecause: "refusal" };
        messages.push({ role: "assistant", content: res.content });
        finalText = textOf(res.content) || finalText;
        const calls = res.content.filter((b) => b.type === "tool_use");
        if (res.stop_reason !== "tool_use" || !calls.length) return { finalText, turns: turn, usage, model: model.id, stoppedBecause: "done" };
        // Run every tool call, then return all results in ONE user message.
        const results = await Promise.all(
          calls.map(async (c) => {
            let out: { content: string; isError?: boolean };
            try {
              out = await req.runTool(String(c.name), (c.input ?? {}) as Record<string, unknown>);
            } catch (e) {
              out = { content: e instanceof Error ? e.message : String(e), isError: true };
            }
            return { type: "tool_result", tool_use_id: c.id, content: out.content.slice(0, 60_000), is_error: out.isError ?? false };
          }),
        );
        messages.push({ role: "user", content: results });
      }
      return { finalText, turns: req.maxTurns, usage, model: model.id, stoppedBecause: "max_turns" };
    },
  };
}
