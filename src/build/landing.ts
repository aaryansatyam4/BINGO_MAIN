import { z } from "zod";
import type { BrandKit } from "@/studio/brand";
import { isRtl } from "@/lang/detect";

/**
 * BINGO LANDING PAGE BUILDER — generates a complete, production-grade
 * Next.js + TypeScript project from structured, approved content.
 * Design: premium type pairing, generous spacing, restrained motion,
 * accessible forms, SEO metadata, JSON-LD, sitemap/robots, privacy page,
 * signed lead capture that flows into BINGO → CRM → Google Sheets.
 */

export const FieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(["text", "email", "tel", "textarea", "select", "country", "url"]),
  required: z.boolean(),
  options: z.array(z.string()),
});

export const LandingContentSchema = z.object({
  seo: z.object({ title: z.string(), description: z.string() }),
  hero: z.object({ eyebrow: z.string(), headline: z.string(), subline: z.string(), primaryCta: z.string(), secondaryCta: z.string() }),
  benefits: z.array(z.object({ title: z.string(), body: z.string(), claimId: z.string() })),
  story: z.object({ title: z.string(), body: z.string() }),
  comparison: z.object({ title: z.string(), columns: z.array(z.string()), rows: z.array(z.object({ label: z.string(), values: z.array(z.string()) })) }),
  evidence: z.array(z.object({ title: z.string(), body: z.string(), source: z.string() })),
  faq: z.array(z.object({ q: z.string(), a: z.string() })),
  form: z.object({ title: z.string(), intro: z.string(), submitLabel: z.string(), consent: z.string(), success: z.string(), fields: z.array(FieldSchema) }),
  privacy: z.object({ title: z.string(), body: z.string() }),
  footer: z.object({ legal: z.string(), disclaimer: z.string() }),
});
export type LandingContent = z.infer<typeof LandingContentSchema>;

export type SiteKind = "product" | "campaign" | "launch" | "distributor" | "corporate-wellness" | "hiring" | "event" | "lead-generation" | "expansion";

export interface SiteSpec {
  kind: SiteKind;
  name: string;
  slug: string;
  brandName: string;
  colors: BrandKit["colors"];
  fonts: BrandKit["fonts"];
  locales: string[]; // first = default
  sections: ("hero" | "benefits" | "story" | "comparison" | "evidence" | "faq" | "form")[];
  heroImage?: { path: string; alt: string };
  productImage?: { path: string; alt: string };
  analytics?: { ga4MeasurementId?: string };
  contactEmail: string;
  siteUrl?: string;
  leadSource: string;
}

export const DEFAULT_FIELDS: Record<SiteKind, z.infer<typeof FieldSchema>[]> = {
  distributor: [
    { name: "company", label: "Company name", type: "text", required: true, options: [] },
    { name: "name", label: "Your name", type: "text", required: true, options: [] },
    { name: "email", label: "Business email", type: "email", required: true, options: [] },
    { name: "phone", label: "Phone / WhatsApp", type: "tel", required: false, options: [] },
    { name: "country", label: "Country", type: "country", required: true, options: [] },
    { name: "website", label: "Company website", type: "url", required: false, options: [] },
    { name: "portfolio", label: "Current product portfolio and channels", type: "textarea", required: false, options: [] },
  ],
  product: [
    { name: "name", label: "Name", type: "text", required: true, options: [] },
    { name: "email", label: "Email", type: "email", required: true, options: [] },
    { name: "message", label: "Message", type: "textarea", required: false, options: [] },
  ],
  campaign: [],
  launch: [],
  "corporate-wellness": [
    { name: "company", label: "Company", type: "text", required: true, options: [] },
    { name: "name", label: "Your name", type: "text", required: true, options: [] },
    { name: "email", label: "Work email", type: "email", required: true, options: [] },
    { name: "employees", label: "Number of employees", type: "select", required: false, options: ["1–50", "51–250", "251–1000", "1000+"] },
  ],
  hiring: [
    { name: "name", label: "Full name", type: "text", required: true, options: [] },
    { name: "email", label: "Email", type: "email", required: true, options: [] },
    { name: "role", label: "Role you are applying for", type: "text", required: true, options: [] },
    { name: "linkedin", label: "LinkedIn or portfolio URL", type: "url", required: false, options: [] },
  ],
  event: [
    { name: "name", label: "Full name", type: "text", required: true, options: [] },
    { name: "email", label: "Email", type: "email", required: true, options: [] },
    { name: "company", label: "Organisation", type: "text", required: false, options: [] },
  ],
  "lead-generation": [],
  expansion: [],
};
for (const k of ["campaign", "launch", "lead-generation", "expansion"] as const) DEFAULT_FIELDS[k] = DEFAULT_FIELDS.product;

const j = (v: unknown) => JSON.stringify(v, null, 2);

export interface GeneratedFile {
  path: string;
  content: string | Buffer;
}

export function generateLandingProject(spec: SiteSpec, content: Record<string, LandingContent>, binary: { path: string; data: Buffer }[] = []): GeneratedFile[] {
  const multi = spec.locales.length > 1;
  const def = spec.locales[0]!;
  const files: GeneratedFile[] = [];
  const add = (path: string, c: string | Buffer) => files.push({ path, content: c });

  add(
    "package.json",
    j({
      name: spec.slug,
      private: true,
      version: "1.0.0",
      scripts: { dev: "next dev", build: "next build", start: "next start", typecheck: "tsc --noEmit", test: "node --test tests/*.test.mjs" },
      dependencies: { next: "16.4.4", react: "19.3.1", "react-dom": "19.3.1" },
      devDependencies: { typescript: "5.9.3", "@types/node": "22.20.5", "@types/react": "19.3.0", "@types/react-dom": "19.3.0" },
      engines: { node: ">=20.9" },
    }),
  );
  add(
    "tsconfig.json",
    j({
      compilerOptions: {
        target: "ES2022",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "react-jsx",
        skipLibCheck: true,
        incremental: true,
        plugins: [{ name: "next" }],
        paths: { "@/*": ["./*"] },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"],
      exclude: ["node_modules"],
    }),
  );
  add(".gitignore", "node_modules\n.next\nnext-env.d.ts\n*.tsbuildinfo\n.vercel\n");
  add(
    "next.config.ts",
    `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: { formats: ["image/avif", "image/webp"] },${multi ? `
  async redirects() {
    return [{ source: "/", destination: "/${def}", permanent: false }];
  },` : ""}
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};

export default nextConfig;
`,
  );

  add(
    "content/site.ts",
    `// Generated by BINGO from approved brand content. Edit through BINGO to keep compliance checks.
export const site = ${j({
      name: spec.name,
      brand: spec.brandName,
      kind: spec.kind,
      locales: spec.locales,
      defaultLocale: def,
      rtl: Object.fromEntries(spec.locales.map((l) => [l, isRtl(l)])),
      colors: spec.colors,
      fonts: spec.fonts,
      sections: spec.sections,
      ga4: spec.analytics?.ga4MeasurementId ?? null,
      contactEmail: spec.contactEmail,
      siteUrl: spec.siteUrl ?? "",
      leadSource: spec.leadSource,
    })} as const;

export type Locale = (typeof site.locales)[number];

export interface SiteImage { path: string; alt: string }
export const images: { hero: SiteImage | null; product: SiteImage | null } = ${j({ hero: spec.heroImage ?? null, product: spec.productImage ?? null })};
`,
  );
  add("content/copy.ts", `import type { LandingContent } from "./types";\n\nexport const copy: Record<string, LandingContent> = ${j(content)};\n`);
  add(
    "content/types.ts",
    `export interface Field { name: string; label: string; type: "text" | "email" | "tel" | "textarea" | "select" | "country" | "url"; required: boolean; options: string[] }
export interface LandingContent {
  seo: { title: string; description: string };
  hero: { eyebrow: string; headline: string; subline: string; primaryCta: string; secondaryCta: string };
  benefits: { title: string; body: string; claimId: string }[];
  story: { title: string; body: string };
  comparison: { title: string; columns: string[]; rows: { label: string; values: string[] }[] };
  evidence: { title: string; body: string; source: string }[];
  faq: { q: string; a: string }[];
  form: { title: string; intro: string; submitLabel: string; consent: string; success: string; fields: Field[] };
  privacy: { title: string; body: string };
  footer: { legal: string; disclaimer: string };
}
`,
  );

  const fontHref = `https://fonts.googleapis.com/css2?${[spec.fonts.heading, spec.fonts.body].map((f) => `family=${f.replace(/ /g, "+")}:wght@400;500;600;700`).join("&")}&display=swap`;

  const layout = (locVar: string) => `      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="${fontHref}" />
        {site.ga4 ? <Analytics id={site.ga4} /> : null}
      </head>
      <body>
        <a className="skip" href="#main">{${locVar} === "${def}" ? "Skip to content" : "↓"}</a>
        {children}
      </body>`;

  if (multi) {
    add(
      "app/[locale]/layout.tsx",
      `import type { Metadata } from "next";
import { notFound } from "next/navigation";
import "../globals.css";
import { site } from "@/content/site";
import { copy } from "@/content/copy";
import { Analytics } from "@/components/Analytics";

export function generateStaticParams() {
  return site.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const c = copy[locale] ?? copy[site.defaultLocale];
  return {
    title: c.seo.title,
    description: c.seo.description,
    alternates: { languages: Object.fromEntries(site.locales.map((l) => [l, \`/\${l}\`])) },
    openGraph: { title: c.seo.title, description: c.seo.description, type: "website", locale },
    ...(site.siteUrl ? { metadataBase: new URL(site.siteUrl) } : {}),
  };
}

export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!(site.locales as readonly string[]).includes(locale)) notFound();
  const rtl = (site.rtl as Record<string, boolean>)[locale];
  return (
    <html lang={locale} dir={rtl ? "rtl" : "ltr"}>
${layout("locale")}
    </html>
  );
}
`,
    );
    add(
      "app/[locale]/page.tsx",
      `import { Landing } from "@/components/Landing";
import { copy } from "@/content/copy";
import { site } from "@/content/site";

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return <Landing c={copy[locale] ?? copy[site.defaultLocale]} locale={locale} />;
}
`,
    );
    add(
      "app/[locale]/privacy/page.tsx",
      `import { Privacy } from "@/components/Privacy";
import { copy } from "@/content/copy";
import { site } from "@/content/site";

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return <Privacy c={copy[locale] ?? copy[site.defaultLocale]} locale={locale} />;
}
`,
    );
  } else {
    add(
      "app/layout.tsx",
      `import type { Metadata } from "next";
import "./globals.css";
import { site } from "@/content/site";
import { copy } from "@/content/copy";
import { Analytics } from "@/components/Analytics";

const c = copy[site.defaultLocale];

export const metadata: Metadata = {
  title: c.seo.title,
  description: c.seo.description,
  openGraph: { title: c.seo.title, description: c.seo.description, type: "website" },
  ...(site.siteUrl ? { metadataBase: new URL(site.siteUrl) } : {}),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = site.defaultLocale;
  const rtl = (site.rtl as Record<string, boolean>)[locale];
  return (
    <html lang={locale} dir={rtl ? "rtl" : "ltr"}>
${layout("locale")}
    </html>
  );
}
`,
    );
    add(
      "app/page.tsx",
      `import { Landing } from "@/components/Landing";
import { copy } from "@/content/copy";
import { site } from "@/content/site";

export default function Page() {
  return <Landing c={copy[site.defaultLocale]} locale={site.defaultLocale} />;
}
`,
    );
    add(
      "app/privacy/page.tsx",
      `import { Privacy } from "@/components/Privacy";
import { copy } from "@/content/copy";
import { site } from "@/content/site";

export default function Page() {
  return <Privacy c={copy[site.defaultLocale]} locale={site.defaultLocale} />;
}
`,
    );
  }

  add(
    "app/sitemap.ts",
    `import type { MetadataRoute } from "next";
import { site } from "@/content/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = site.siteUrl || "https://example.com";
  return ${multi ? "site.locales.map((l) => ({ url: `${base}/${l}`, changeFrequency: \"monthly\" as const, priority: 1 }))" : '[{ url: base, changeFrequency: "monthly", priority: 1 }]'};
}
`,
  );
  add(
    "app/robots.ts",
    `import type { MetadataRoute } from "next";
import { site } from "@/content/site";

export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/", disallow: "/api/" }], ...(site.siteUrl ? { sitemap: \`\${site.siteUrl}/sitemap.xml\` } : {}) };
}
`,
  );

  add(
    "app/api/lead/route.ts",
    `import { createHmac } from "node:crypto";
import { site } from "@/content/site";

// Validates the submission, then forwards it to BINGO, signed with LEAD_SIGNING_SECRET.
// BINGO stores the lead in the CRM, appends it to Google Sheets and creates follow-up tasks.
const MAX = 2000;

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
  if (typeof body.website_confirm === "string" && body.website_confirm) return Response.json({ ok: true }); // honeypot
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string" && k.length < 40) fields[k] = v.slice(0, MAX).trim();
  if (!fields.email || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(fields.email)) return Response.json({ ok: false, error: "Please enter a valid email." }, { status: 422 });
  if (fields.consent !== "yes") return Response.json({ ok: false, error: "Please accept the privacy notice." }, { status: 422 });

  const url = process.env.BINGO_INTAKE_URL;
  const secret = process.env.LEAD_SIGNING_SECRET;
  if (!url || !secret) return Response.json({ ok: false, error: "Form is not connected yet." }, { status: 503 });
  const payload = JSON.stringify({ source: site.leadSource, site: site.name, locale: fields.locale ?? site.defaultLocale, fields, at: new Date().toISOString() });
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-bingo-signature": signature }, body: payload });
  if (!res.ok) return Response.json({ ok: false, error: "Could not submit right now. Please try again." }, { status: 502 });
  return Response.json({ ok: true });
}
`,
  );

  add(
    "components/Analytics.tsx",
    `export function Analytics({ id }: { id: string }) {
  const init = \`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config',\${JSON.stringify(id)},{anonymize_ip:true});\`;
  return (
    <>
      <script async src={\`https://www.googletagmanager.com/gtag/js?id=\${encodeURIComponent(id)}\`} />
      <script dangerouslySetInnerHTML={{ __html: init }} />
    </>
  );
}
`,
  );

  add(
    "components/LeadForm.tsx",
    `"use client";
import { useState } from "react";
import type { LandingContent } from "@/content/types";

declare global {
  interface Window { gtag?: (...args: unknown[]) => void }
}

export function LeadForm({ f, locale, privacyHref }: { f: LandingContent["form"]; locale: string; privacyHref: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("sending");
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    const res = await fetch("/api/lead", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...data, locale }) }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok && json.ok) {
      setState("done");
      window.gtag?.("event", "generate_lead", { form_locale: locale });
    } else {
      setState("error");
      setError(json.error ?? "Something went wrong.");
    }
  }

  if (state === "done") return <p className="success" role="status">{f.success}</p>;

  return (
    <form className="form" onSubmit={onSubmit} noValidate={false}>
      {f.fields.map((field) => (
        <div className={\`field \${field.type === "textarea" ? "wide" : ""}\`} key={field.name}>
          <label htmlFor={\`f-\${field.name}\`}>
            {field.label}
            {field.required ? <span aria-hidden="true"> *</span> : null}
          </label>
          {field.type === "textarea" ? (
            <textarea id={\`f-\${field.name}\`} name={field.name} required={field.required} rows={4} />
          ) : field.type === "select" ? (
            <select id={\`f-\${field.name}\`} name={field.name} required={field.required} defaultValue="">
              <option value="" disabled>—</option>
              {field.options.map((o) => <option key={o}>{o}</option>)}
            </select>
          ) : (
            <input
              id={\`f-\${field.name}\`}
              name={field.name}
              type={field.type === "country" ? "text" : field.type}
              required={field.required}
              autoComplete={field.type === "email" ? "email" : field.type === "tel" ? "tel" : field.name === "name" ? "name" : field.name === "company" ? "organization" : field.type === "country" ? "country-name" : "on"}
            />
          )}
        </div>
      ))}
      <input className="hp" tabIndex={-1} autoComplete="off" name="website_confirm" aria-hidden="true" />
      <div className="field wide consent">
        <input id="f-consent" type="checkbox" name="consent" value="yes" required />
        <label htmlFor="f-consent">{f.consent} <a href={privacyHref}>↗</a></label>
      </div>
      <button className="btn primary" type="submit" disabled={state === "sending"}>{state === "sending" ? "…" : f.submitLabel}</button>
      {state === "error" ? <p className="error" role="alert">{error}</p> : null}
    </form>
  );
}
`,
  );

  add(
    "components/Landing.tsx",
    `import Image from "next/image";
import type { LandingContent } from "@/content/types";
import { images, site } from "@/content/site";
import { LeadForm } from "./LeadForm";
import { Reveal } from "./Reveal";

export function Landing({ c, locale }: { c: LandingContent; locale: string }) {
  const show = (s: string) => (site.sections as readonly string[]).includes(s);
  const prefix = ${multi ? "`/${locale}`" : '""'};
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: c.seo.title,
    description: c.seo.description,
    inLanguage: locale,
    publisher: { "@type": "Organization", name: site.brand },
    ...(c.faq.length ? { mainEntity: { "@type": "FAQPage", mainEntity: c.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) } } : {}),
  };
  return (
    <>
      <header className="nav">
        <div className="wrap navrow">
          <span className="logo">{site.brand}</span>
          {show("form") ? <a className="btn small" href="#contact">{c.hero.primaryCta}</a> : null}
        </div>
      </header>
      <main id="main">
        <section className="hero">
          <div className="wrap herogrid">
            <div className="herocopy">
              {c.hero.eyebrow ? <p className="eyebrow">{c.hero.eyebrow}</p> : null}
              <h1>{c.hero.headline}</h1>
              <p className="lead">{c.hero.subline}</p>
              <div className="ctas">
                {show("form") ? <a className="btn primary" href="#contact">{c.hero.primaryCta}</a> : null}
                {c.hero.secondaryCta ? <a className="btn ghost" href={show("benefits") ? "#benefits" : "#faq"}>{c.hero.secondaryCta}</a> : null}
              </div>
            </div>
            <div className="heroart" aria-hidden={images.product || images.hero ? undefined : true}>
              {images.hero ? <Image className="herobg" src={images.hero.path} alt={images.hero.alt} fill priority sizes="(max-width: 900px) 100vw, 50vw" /> : <div className="orb" />}
              {images.product ? <Image className="pack" src={images.product.path} alt={images.product.alt} width={520} height={720} priority /> : null}
            </div>
          </div>
        </section>

        {show("benefits") && c.benefits.length ? (
          <section id="benefits" className="section">
            <div className="wrap grid3">
              {c.benefits.map((b, i) => (
                <Reveal key={i} delay={i * 80}>
                  <article className="card">
                    <span className="num">{String(i + 1).padStart(2, "0")}</span>
                    <h2 className="h3">{b.title}</h2>
                    <p>{b.body}</p>
                  </article>
                </Reveal>
              ))}
            </div>
          </section>
        ) : null}

        {show("story") && c.story.title ? (
          <section className="section alt">
            <div className="wrap narrow">
              <Reveal><h2>{c.story.title}</h2></Reveal>
              {c.story.body.split("\\n\\n").map((p, i) => <p key={i} className="prose">{p}</p>)}
            </div>
          </section>
        ) : null}

        {show("comparison") && c.comparison.rows.length ? (
          <section className="section">
            <div className="wrap">
              <h2>{c.comparison.title}</h2>
              <div className="tablewrap">
                <table>
                  <thead><tr><th scope="col"><span className="sr">—</span></th>{c.comparison.columns.map((col) => <th scope="col" key={col}>{col}</th>)}</tr></thead>
                  <tbody>{c.comparison.rows.map((r) => <tr key={r.label}><th scope="row">{r.label}</th>{r.values.map((v, i) => <td key={i}>{v}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
          </section>
        ) : null}

        {show("evidence") && c.evidence.length ? (
          <section className="section alt">
            <div className="wrap grid2">
              {c.evidence.map((e, i) => (
                <article className="card flat" key={i}>
                  <h2 className="h3">{e.title}</h2>
                  <p>{e.body}</p>
                  {e.source ? <p className="source">{e.source}</p> : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {show("faq") && c.faq.length ? (
          <section id="faq" className="section">
            <div className="wrap narrow">
              <h2>FAQ</h2>
              {c.faq.map((f, i) => (
                <details key={i} className="faq">
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </section>
        ) : null}

        {show("form") ? (
          <section id="contact" className="section contact">
            <div className="wrap grid2 formgrid">
              <div>
                <h2>{c.form.title}</h2>
                <p className="lead">{c.form.intro}</p>
              </div>
              <LeadForm f={c.form} locale={locale} privacyHref={\`\${prefix}/privacy\`} />
            </div>
          </section>
        ) : null}
      </main>
      <footer className="footer">
        <div className="wrap">
          {c.footer.disclaimer ? <p className="disclaimer">{c.footer.disclaimer}</p> : null}
          <p>© {new Date().getFullYear()} {site.brand}. {c.footer.legal} · <a href={\`\${prefix}/privacy\`}>{c.privacy.title}</a></p>
        </div>
      </footer>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\\\u003c") }} />
    </>
  );
}
`,
  );

  add(
    "components/Reveal.tsx",
    `"use client";
import { useEffect, useRef, useState } from "react";

/** Subtle entrance animation; disabled for people who prefer reduced motion. */
export function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setShown(true);
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && (setShown(true), io.disconnect()), { rootMargin: "0px 0px -10% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={\`reveal \${shown ? "in" : ""}\`} style={{ transitionDelay: \`\${delay}ms\` }}>{children}</div>;
}
`,
  );

  add(
    "components/Privacy.tsx",
    `import type { LandingContent } from "@/content/types";
import { site } from "@/content/site";

export function Privacy({ c, locale }: { c: LandingContent; locale: string }) {
  return (
    <main id="main" className="section">
      <div className="wrap narrow">
        <p><a href={${multi ? "`/${locale}`" : '"/"'}}>← {site.brand}</a></p>
        <h1>{c.privacy.title}</h1>
        {c.privacy.body.split("\\n\\n").map((p, i) => <p className="prose" key={i}>{p}</p>)}
        <p className="prose">{site.contactEmail ? <a href={\`mailto:\${site.contactEmail}\`}>{site.contactEmail}</a> : null}</p>
      </div>
    </main>
  );
}
`,
  );

  add("app/globals.css", globalsCss(spec));
  for (const b of binary) add(b.path, b.data);

  add(
    "tests/site.test.mjs",
    `// Post-build quality checks, run by BINGO after \`next build\` (and in CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APP = ".next/server/app";
const pages = ${j(multi ? spec.locales.map((l) => `${l}.html`) : ["index.html"])};

function html(p) {
  const file = join(APP, p);
  assert.ok(existsSync(file), \`prerendered page \${p} exists (found: \${existsSync(APP) ? readdirSync(APP).join(", ") : "no build"})\`);
  return readFileSync(file, "utf8");
}

for (const p of pages) {
  test(\`\${p}: SEO basics\`, () => {
    const h = html(p);
    assert.match(h, /<html[^>]+lang="[a-zA-Z-]+"/);
    assert.match(h, /<title>[^<]{10,}<\\/title>/);
    assert.match(h, /<meta name="description" content="[^"]{30,}"/);
    assert.equal((h.match(/<h1[\\s>]/g) || []).length, 1, "exactly one h1");
    assert.match(h, /application\\/ld\\+json/);
  });
  test(\`\${p}: accessibility basics\`, () => {
    const h = html(p);
    for (const img of h.match(/<img[^>]*>/g) || []) assert.match(img, /alt="/, "every image has alt text");
    const ids = [...h.matchAll(/<(?:input|textarea|select)[^>]*id="([^"]+)"/g)].map((m) => m[1]);
    for (const id of ids) assert.ok(h.includes(\`for="\${id}"\`), \`field \${id} has a label\`);
    assert.match(h, /class="skip"/, "skip link");
  });
  test(\`\${p}: no placeholder text\`, () => {
    const h = html(p).toLowerCase();
    for (const bad of ["lorem ipsum", "todo", "[insert", "placeholder text"]) assert.ok(!h.includes(bad), bad);
  });
}
`,
  );
  add(
    "README.md",
    `# ${spec.name}

Generated and maintained by **BINGO BUILD** for ${spec.brandName}.

- Next.js (App Router) + TypeScript, statically prerendered.
- Locales: ${spec.locales.join(", ")}.
- Lead form → \`/api/lead\` → signed POST to BINGO (\`BINGO_INTAKE_URL\`, \`LEAD_SIGNING_SECRET\`) → CRM + Google Sheets.

\`\`\`bash
npm install
npm run typecheck && npm run build && npm test
\`\`\`

Content lives in \`content/copy.ts\` and is compliance-checked by BINGO against approved claims. Please change copy through BINGO so the checks run again.
`,
  );
  return files;
}

function globalsCss(spec: SiteSpec): string {
  const c = spec.colors;
  return `:root {
  --primary: ${c.primary};
  --secondary: ${c.secondary};
  --accent: ${c.accent};
  --bg: ${c.background};
  --text: ${c.text};
  --muted: ${c.muted};
  --heading: "${spec.fonts.heading}", ui-serif, Georgia, serif;
  --body: "${spec.fonts.body}", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --radius: 20px;
  --ease: cubic-bezier(.2,.7,.2,1);
}
*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 400 17px/1.65 var(--body); text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }
img { max-width: 100%; height: auto; }
a { color: inherit; text-underline-offset: 3px; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; border-radius: 6px; }
.skip { position: absolute; left: -9999px; top: 8px; background: var(--primary); color: #fff; padding: 8px 14px; border-radius: 8px; z-index: 50; }
.skip:focus { left: 12px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.wrap { width: min(1180px, 100% - 48px); margin-inline: auto; }
.narrow { width: min(760px, 100% - 48px); }
h1, h2, .h3 { font-family: var(--heading); font-weight: 600; letter-spacing: -0.02em; line-height: 1.08; margin: 0 0 .5em; }
h1 { font-size: clamp(2.6rem, 6vw, 5rem); }
h2 { font-size: clamp(1.9rem, 3.6vw, 3rem); }
.h3 { font-size: 1.45rem; line-height: 1.2; }
.lead { font-size: clamp(1.1rem, 1.6vw, 1.3rem); color: var(--muted); max-width: 38ch; }
.prose { max-width: 66ch; color: var(--muted); }
.eyebrow { text-transform: uppercase; letter-spacing: .16em; font-size: .78rem; font-weight: 600; color: var(--accent); margin: 0 0 1.2rem; }
.nav { position: sticky; top: 0; z-index: 20; backdrop-filter: saturate(140%) blur(14px); background: color-mix(in srgb, var(--bg) 82%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--text) 8%, transparent); }
.navrow { display: flex; align-items: center; justify-content: space-between; height: 68px; }
.logo { font-family: var(--heading); font-weight: 600; font-size: 1.25rem; letter-spacing: -0.01em; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: .5em; min-height: 52px; padding: 0 1.6rem; border-radius: 999px; font-weight: 600; text-decoration: none; border: 1px solid transparent; cursor: pointer; font: inherit; transition: transform .25s var(--ease), box-shadow .25s var(--ease), background .25s; }
.btn.small { min-height: 40px; padding: 0 1.1rem; font-size: .92rem; background: var(--primary); color: #fff; }
.btn.primary { background: var(--primary); color: #fff; box-shadow: 0 10px 30px -12px color-mix(in srgb, var(--primary) 70%, transparent); }
.btn.primary:hover { transform: translateY(-2px); box-shadow: 0 16px 40px -14px color-mix(in srgb, var(--primary) 80%, transparent); }
.btn.ghost { border-color: color-mix(in srgb, var(--text) 18%, transparent); background: transparent; color: var(--text); }
.btn:disabled { opacity: .6; cursor: progress; }
.hero { padding: clamp(48px, 9vw, 120px) 0 clamp(56px, 8vw, 110px); overflow: hidden; }
.herogrid { display: grid; grid-template-columns: 1.05fr .95fr; gap: clamp(32px, 5vw, 72px); align-items: center; }
.ctas { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 2rem; }
.heroart { position: relative; aspect-ratio: 4 / 5; border-radius: calc(var(--radius) * 1.6); overflow: hidden; background: radial-gradient(120% 90% at 70% 20%, color-mix(in srgb, var(--accent) 22%, var(--secondary)), var(--secondary)); display: grid; place-items: center; }
.herobg { object-fit: cover; }
.pack { position: relative; width: 62%; height: auto; filter: drop-shadow(0 40px 50px rgba(0,0,0,.18)); animation: float 7s var(--ease) infinite alternate; }
.orb { width: 62%; aspect-ratio: 1; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #fff, color-mix(in srgb, var(--accent) 35%, var(--secondary)) 60%, transparent 70%); filter: blur(2px); animation: float 9s var(--ease) infinite alternate; }
@keyframes float { from { transform: translateY(-8px); } to { transform: translateY(10px); } }
.section { padding: clamp(64px, 9vw, 128px) 0; }
.section.alt { background: var(--secondary); }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.grid2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: clamp(24px, 4vw, 56px); }
.card { height: 100%; padding: 32px; border-radius: var(--radius); background: #fff; border: 1px solid color-mix(in srgb, var(--text) 7%, transparent); box-shadow: 0 1px 0 rgba(0,0,0,.02), 0 24px 48px -32px rgba(15,30,45,.25); }
.card.flat { box-shadow: none; }
.card p { color: var(--muted); margin: 0; }
.num { display: inline-block; font: 600 .8rem/1 var(--body); color: var(--accent); letter-spacing: .1em; margin-bottom: 1.4rem; }
.source { font-size: .85rem; margin-top: 1rem !important; }
.tablewrap { overflow-x: auto; border-radius: var(--radius); border: 1px solid color-mix(in srgb, var(--text) 10%, transparent); }
table { width: 100%; border-collapse: collapse; background: #fff; }
th, td { padding: 18px 20px; text-align: start; border-bottom: 1px solid color-mix(in srgb, var(--text) 8%, transparent); }
thead th { font-size: .85rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.faq { border-bottom: 1px solid color-mix(in srgb, var(--text) 12%, transparent); padding: 18px 0; }
.faq summary { cursor: pointer; font-weight: 600; font-size: 1.08rem; list-style: none; display: flex; justify-content: space-between; gap: 16px; }
.faq summary::after { content: "+"; color: var(--accent); font-size: 1.4rem; line-height: 1; transition: transform .3s var(--ease); }
.faq[open] summary::after { transform: rotate(45deg); }
.faq p { color: var(--muted); margin: .8rem 0 0; }
.contact { background: var(--primary); color: #fff; }
.contact .lead { color: color-mix(in srgb, #fff 78%, transparent); }
.formgrid { align-items: start; }
.form { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; background: #fff; color: var(--text); padding: clamp(24px, 3vw, 36px); border-radius: var(--radius); }
.field { display: grid; gap: 6px; }
.field.wide, .form .btn, .form .error { grid-column: 1 / -1; }
.field label { font-size: .9rem; font-weight: 500; }
.field input, .field textarea, .field select { font: inherit; padding: 13px 14px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--text) 18%, transparent); background: var(--bg); color: var(--text); }
.field input:focus, .field textarea:focus, .field select:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent); }
.consent { grid-template-columns: auto 1fr; align-items: start; gap: 10px; font-size: .88rem; color: var(--muted); }
.consent input { margin-top: 4px; width: 18px; height: 18px; }
.hp { position: absolute; left: -10000px; }
.error { color: #B3261E; margin: 0; }
.success { background: #fff; color: var(--text); padding: 32px; border-radius: var(--radius); font-size: 1.15rem; }
.footer { padding: 40px 0 56px; font-size: .9rem; color: var(--muted); }
.disclaimer { font-size: .82rem; max-width: 80ch; }
.reveal { opacity: 0; transform: translateY(18px); transition: opacity .8s var(--ease), transform .8s var(--ease); height: 100%; }
.reveal.in { opacity: 1; transform: none; }
[dir="rtl"] .eyebrow { letter-spacing: 0; }
@media (max-width: 900px) {
  .herogrid, .grid2, .grid3 { grid-template-columns: 1fr; }
  .heroart { aspect-ratio: 1; }
  .form { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  .reveal { opacity: 1; transform: none; }
}
`;
}
