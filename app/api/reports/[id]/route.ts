import { getCtx } from "@/core/context";
import type { Report } from "@/reports/report";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getCtx().store.get<Report>("reports", id);
  if (!r) return new Response("Not found", { status: 404 });
  if (new URL(req.url).searchParams.get("format") === "pdf" && r.pdfB64)
    return new Response(new Uint8Array(Buffer.from(r.pdfB64, "base64")), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${encodeURIComponent(r.title)}.pdf"` } });
  return new Response(r.html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } });
}
