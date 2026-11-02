import { getCtx } from "@/core/context";
import { getAsset } from "@/studio/brand";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await getAsset(getCtx(), id);
  if (!a) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(Buffer.from(a.b64, "base64")), { headers: { "content-type": a.mime, "cache-control": "private, max-age=3600" } });
}
