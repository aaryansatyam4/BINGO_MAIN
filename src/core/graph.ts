import type { Ctx } from "./context";

/**
 * Company knowledge graph: lightweight nodes + typed edges stored in the
 * document store. Used to connect companies, people, countries, products,
 * messages, meetings, projects and reports so BINGO can answer "what do we
 * know about X" and prepare meeting briefs from real history.
 */
export interface GraphNode {
  id: string; // "<kind>:<key>"
  kind: "company" | "person" | "country" | "product" | "message" | "meeting" | "project" | "report" | "deal" | "creative";
  label: string;
  data: Record<string, unknown>;
  updatedAt: string;
}

export interface GraphEdge {
  id: string; // from|rel|to
  from: string;
  rel: string;
  to: string;
  at: string;
}

export async function upsertNode(ctx: Ctx, n: Omit<GraphNode, "updatedAt">) {
  const cur = await ctx.store.get<GraphNode>("kg_nodes", n.id);
  await ctx.store.put("kg_nodes", { ...cur, ...n, data: { ...(cur?.data ?? {}), ...n.data }, updatedAt: ctx.now().toISOString() });
}

export async function link(ctx: Ctx, from: string, rel: string, to: string) {
  const id = `${from}|${rel}|${to}`;
  if (await ctx.store.get("kg_edges", id)) return;
  await ctx.store.put("kg_edges", { id, from, rel, to, at: ctx.now().toISOString() } satisfies GraphEdge);
}

export async function neighbours(ctx: Ctx, nodeId: string): Promise<{ edge: GraphEdge; node: GraphNode | null }[]> {
  const out = await ctx.store.list<GraphEdge>("kg_edges", { where: { from: nodeId } });
  const inc = await ctx.store.list<GraphEdge>("kg_edges", { where: { to: nodeId } });
  const res: { edge: GraphEdge; node: GraphNode | null }[] = [];
  for (const e of out) res.push({ edge: e, node: await ctx.store.get<GraphNode>("kg_nodes", e.to) });
  for (const e of inc) res.push({ edge: e, node: await ctx.store.get<GraphNode>("kg_nodes", e.from) });
  return res;
}
