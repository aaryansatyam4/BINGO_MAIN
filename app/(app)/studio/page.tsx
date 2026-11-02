import Link from "next/link";
import { getCtx } from "@/core/context";
import { listBrandKits } from "@/studio/brand";
import { FORMATS } from "@/studio/compose";
import { listCreatives } from "@/studio/creative";
import { route } from "@/ai/engine";
import { Submit } from "../../client";
import { studioGenerate } from "../../actions";
import { Card, Empty, PageHead, Status } from "../../ui";

export const dynamic = "force-dynamic";

export default async function StudioPage() {
  const ctx = getCtx();
  const [kits, creatives, imageRoute, copyRoute] = await Promise.all([listBrandKits(ctx), listCreatives(ctx), route(ctx, "image.generate"), route(ctx, "copywriting")]);
  return (
    <>
      <PageHead title="BINGO Studio" sub="Ads, social posts, banners, infographics, brochures and more — on-brand, with approved claims only." action={<Link className="btn" href="/studio/brand">Brand kits</Link>} />
      {!copyRoute.length ? <p className="notice">Copywriting needs an AI model. <Link href="/settings#ai">Connect Claude</Link>.</p> : null}
      {!imageRoute.length ? <p className="notice">No image-generation provider connected: backgrounds will use brand gradients. <Link href="/settings#ai">Connect OpenAI or Gemini</Link> for photographic scenes.</p> : null}
      <Card title="Create">
        <form action={studioGenerate} className="grid g2">
          <div>
            <div className="field"><label htmlFor="brief">What should BINGO create?</label><textarea id="brief" name="brief" required placeholder="Five premium advertising creatives for SleepTime, calm night mood, for Instagram" /></div>
            <div className="field"><label htmlFor="style">Style references (optional)</label><input id="style" name="style" placeholder="e.g. Aesop, soft daylight, linen textures" /></div>
            <div className="grid g3">
              <div className="field"><label htmlFor="brandKitId">Brand</label><select id="brandKitId" name="brandKitId">{kits.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select></div>
              <div className="field"><label htmlFor="productId">Product</label><select id="productId" name="productId"><option value="">— brand only —</option>{kits.flatMap((k) => k.products.map((p) => <option key={p.id} value={p.id}>{k.name} · {p.name}</option>))}</select></div>
              <div className="field"><label htmlFor="count">Concepts</label><input id="count" name="count" type="number" min={1} max={8} defaultValue={3} /></div>
            </div>
            <div className="field"><label htmlFor="language">Language (optional, BCP-47)</label><input id="language" name="language" placeholder="en, ru, hi, ar…" /></div>
          </div>
          <div>
            <label>Formats</label>
            <div className="checks" style={{ flexDirection: "column", gap: 6 }}>
              {Object.entries(FORMATS).map(([k, f]) => <label key={k}><input type="checkbox" name="formats" value={k} defaultChecked={["instagram-square", "instagram-portrait", "web-hero"].includes(k)} /> {f.label} <span className="faint">{f.width}×{f.height}</span></label>)}
            </div>
            <div style={{ marginTop: 16 }}><Submit pending="Starting…">Generate creatives</Submit></div>
          </div>
        </form>
      </Card>
      <div className="section-title"><h2>Gallery</h2><span className="faint">{creatives.length} creatives</span></div>
      {creatives.length ? (
        <div className="gallery">
          {creatives.map((c) => {
            const v = c.versions.at(-1)!;
            return (
              <Link key={c.id} href={`/studio/${c.id}`} className="thumb" style={{ color: "inherit", textDecoration: "none" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/creatives/${c.id}/svg?format=${v.specs[0]!.format}`} alt={v.copy.headline} loading="lazy" />
                <div className="meta">
                  <div className="row between"><strong className="small">{c.concept.name}</strong><Status value={c.status} /></div>
                  <div className="faint">{v.copy.headline} · v{v.v} · {v.specs.length} formats</div>
                </div>
              </Link>
            );
          })}
        </div>
      ) : <Card><Empty>No creatives yet.</Empty></Card>}
    </>
  );
}
