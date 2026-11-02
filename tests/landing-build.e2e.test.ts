import { describe, expect, it } from "vitest";
import { generateLandingProject } from "@/build/landing";
import { LocalSandbox, runQualityGate } from "@/build/sandbox";
import { scanProject } from "@/build/scan";
import { sampleContent, sampleSpec } from "./helpers";

/**
 * Real end-to-end build of a generated site: npm install → tsc → next build → site tests.
 * Needs network access to the npm registry, so it only runs with BINGO_E2E_BUILD=1.
 */
const run = process.env.BINGO_E2E_BUILD === "1" ? describe : describe.skip;

run("generated landing page builds for real", () => {
  it(
    "single-locale product page passes install, typecheck, build and its own tests",
    async () => {
      const files = generateLandingProject(sampleSpec(), { en: sampleContent() });
      expect(scanProject(files).filter((f) => f.severity === "block")).toEqual([]);
      const sbx = await LocalSandbox.create();
      try {
        await sbx.writeFiles(files);
        const gate = await runQualityGate(sbx);
        if (!gate.ok) console.error(gate.steps.at(-1)?.output);
        expect(gate.steps.map((s) => [s.name, s.ok])).toEqual([
          ["install", true],
          ["typecheck", true],
          ["build", true],
          ["test", true],
        ]);
      } finally {
        await sbx.stop();
      }
    },
    15 * 60_000,
  );

  it(
    "multilingual distributor page (ru + en, plus Arabic RTL) builds and passes tests",
    async () => {
      const spec = sampleSpec({ kind: "distributor", locales: ["ru", "en", "ar"], slug: "carpediem-distributors" });
      const ru = sampleContent({
        seo: { title: "Carpediem — партнёрство с дистрибьюторами", description: "Станьте дистрибьютором Carpediem: заполните форму, и наша команда свяжется с вами в течение одного рабочего дня." },
        hero: { eyebrow: "Carpediem", headline: "Станьте нашим партнёром", subline: "Расскажите о вашей компании.", primaryCta: "Отправить заявку", secondaryCta: "Подробнее" },
      });
      const ar = sampleContent({
        seo: { title: "كارب ديم — شراكة التوزيع معنا", description: "كن موزعًا لمنتجات كارب ديم: املأ النموذج وسيتواصل فريقنا معك خلال يوم عمل واحد بكل سرور." },
        hero: { eyebrow: "Carpediem", headline: "كن شريكنا", subline: "أخبرنا عن شركتك.", primaryCta: "أرسل الطلب", secondaryCta: "المزيد" },
      });
      const files = generateLandingProject(spec, { ru, en: sampleContent(), ar });
      const sbx = await LocalSandbox.create();
      try {
        await sbx.writeFiles(files);
        const gate = await runQualityGate(sbx);
        if (!gate.ok) console.error(gate.steps.at(-1)?.output);
        expect(gate.ok).toBe(true);
        const arHtml = await sbx.readFile(".next/server/app/ar.html");
        expect(arHtml).toContain('dir="rtl"');
        const ruHtml = await sbx.readFile(".next/server/app/ru.html");
        expect(ruHtml).toContain('lang="ru"');
        expect(ruHtml).toContain("Станьте нашим партнёром");
      } finally {
        await sbx.stop();
      }
    },
    15 * 60_000,
  );
});
