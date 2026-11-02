import { getCtx } from "@/core/context";
import { listBrandKits } from "@/studio/brand";
import { Submit } from "../../../client";
import { saveBrand, saveProduct } from "../../../actions";
import { Badge, Card, PageHead } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function BrandPage() {
  const kits = await listBrandKits(getCtx());
  return (
    <>
      <PageHead title="Brand kits" sub="BINGO reuses only what is approved here. It never invents packaging, certifications, evidence, prices or testimonials." />
      {kits.map((k) => (
        <div key={k.id} className="stack" style={{ marginBottom: 30 }}>
          <Card title={<span className="row">{k.name} {k.verified ? <Badge tone="good">verified</Badge> : <Badge tone="warn">draft — please confirm</Badge>}</span>}>
            <form action={saveBrand} className="grid g2" encType="multipart/form-data">
              <input type="hidden" name="id" value={k.id} />
              <div>
                <div className="field"><label>Name</label><input name="name" defaultValue={k.name} /></div>
                <div className="grid g3">
                  {Object.entries(k.colors).map(([name, val]) => (
                    <div className="field" key={name}><label>{name}</label><div className="row" style={{ flexWrap: "nowrap" }}><span style={{ width: 26, height: 26, borderRadius: 6, background: val, border: "1px solid var(--line)" }} /><input name={`color_${name}`} defaultValue={val} pattern="#[0-9a-fA-F]{6}" /></div></div>
                  ))}
                </div>
                <div className="grid g2">
                  <div className="field"><label>Heading font (Google Fonts name)</label><input name="fontHeading" defaultValue={k.fonts.heading} /></div>
                  <div className="field"><label>Body font</label><input name="fontBody" defaultValue={k.fonts.body} /></div>
                </div>
                <div className="field"><label>Tone (comma separated)</label><input name="tone" defaultValue={k.tone.join(", ")} /></div>
                <div className="field"><label>Logo</label><input type="file" name="logo" accept="image/png,image/svg+xml,image/jpeg,image/webp" /></div>
              </div>
              <div>
                <div className="field"><label>Visual guidelines</label><textarea name="visualGuidelines" defaultValue={k.visualGuidelines} /></div>
                <div className="field"><label>Target audience</label><input name="targetAudience" defaultValue={k.targetAudience} /></div>
                <div className="field"><label>Approved company facts (one per line — used in outreach and websites)</label><textarea name="companyFacts" defaultValue={k.companyFacts.join("\n")} placeholder="e.g. Founded in 20XX · Manufacturing partner certified … (only verified facts)" /></div>
                <div className="field"><label>Regulatory constraints (one per line)</label><textarea name="regulatoryConstraints" defaultValue={k.regulatoryConstraints.join("\n")} /></div>
                <div className="field"><label>Forbidden phrases (comma separated)</label><input name="forbiddenPhrases" defaultValue={k.forbiddenPhrases.join(", ")} /></div>
                <label className="row" style={{ color: "var(--text)" }}><input type="checkbox" name="verified" defaultChecked={k.verified} /> I confirm this kit reflects our official brand guidelines</label>
                <div style={{ marginTop: 10 }}><Submit>Save brand kit</Submit></div>
              </div>
            </form>
          </Card>
          {[...k.products, null].map((p) => (
            <Card key={p?.id ?? "new"} title={p ? p.name : "Add a product"} action={p ? <span className="faint">{p.approvedClaims.length} approved claims · {p.packshotAssetIds.length} packshots</span> : null}>
              <form action={saveProduct} className="grid g2" encType="multipart/form-data">
                <input type="hidden" name="kitId" value={k.id} />
                <input type="hidden" name="productId" value={p?.id ?? ""} />
                <div>
                  <div className="grid g2">
                    <div className="field"><label>Name</label><input name="name" defaultValue={p?.name} required /></div>
                    <div className="field"><label>Category</label><input name="category" defaultValue={p?.category} placeholder="e.g. dietary supplement" /></div>
                  </div>
                  <div className="field"><label>Approved description</label><textarea name="description" defaultValue={p?.description} /></div>
                  <div className="field"><label>Approved product facts (one per line)</label><textarea name="facts" defaultValue={p?.facts.join("\n")} placeholder="Pack size, format, ingredients with amounts…" /></div>
                </div>
                <div>
                  <div className="field"><label>Approved claims (one per line, exactly as approved — include evidence references in your records)</label><textarea name="claims" defaultValue={p?.approvedClaims.map((c) => c.text).join("\n")} /></div>
                  <div className="field"><label>Disclaimer</label><input name="disclaimer" defaultValue={p?.disclaimer} /></div>
                  <div className="grid g3">
                    <div className="field" style={{ gridColumn: "span 1" }}><label>Approved packshot</label><input type="file" name="packshot" accept="image/png,image/webp,image/jpeg" /></div>
                    <div className="field"><label>Width px</label><input name="packWidth" type="number" /></div>
                    <div className="field"><label>Height px</label><input name="packHeight" type="number" /></div>
                  </div>
                  {p?.packshotAssetIds[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/assets/${p.packshotAssetIds[0]}`} alt={`${p.name} packshot`} style={{ height: 90, borderRadius: 8, background: "#fff" }} />
                  ) : null}
                  <div style={{ marginTop: 10 }}><Submit>{p ? "Save product" : "Add product"}</Submit></div>
                  {!p ? <p className="faint">Adding a product triggers your “new product launched” skills, if any.</p> : null}
                </div>
              </form>
            </Card>
          ))}
        </div>
      ))}
    </>
  );
}
