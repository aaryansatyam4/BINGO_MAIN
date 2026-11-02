import { getCtx } from "@/core/context";
import { getCreative, renderCreativeSvg } from "@/studio/creative";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = new URL(req.url);
  const ctx = getCtx();
  const c = await getCreative(ctx, id);
  if (!c) return new Response("Not found", { status: 404 });
  const svg = await renderCreativeSvg(ctx, c, u.searchParams.get("format") ?? undefined, Number(u.searchParams.get("v")) || undefined);
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com",
      ...(u.searchParams.get("download") ? { "content-disposition": `attachment; filename="${c.concept.name.replace(/[^\w-]+/g, "_")}-${u.searchParams.get("format") ?? "creative"}.svg"` } : {}),
    },
  });
}
