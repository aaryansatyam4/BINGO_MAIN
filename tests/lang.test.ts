import { afterEach, describe, expect, it } from "vitest";
import { detectLanguage, isRtl, languageName } from "@/lang/detect";
import { listLanguages, languageSupport, protect, refreshLanguageRegistry, restore, translateText } from "@/lang/translate";
import { setAdapterFactory } from "@/ai/engine";
import { connectFakeAi } from "./fakes/ai";
import { testCtx } from "./helpers";

afterEach(() => setAdapterFactory(null));

describe("language detection", () => {
  const samples: [string, string][] = [
    ["ru", "Здравствуйте! Мы заинтересованы в сотрудничестве с вашей компанией и будем рады обсудить условия."],
    ["uz-Cyrl", "Ассалому алайкум! Биз сизнинг компаниянгиз билан ҳамкорлик қилишдан хурсандмиз, рахмат."],
    ["uz", "Assalomu alaykum! Biz sizning kompaniyangiz bilan hamkorlik qilishdan xursandmiz, rahmat. Bizning mahsulotlar yaxshi."],
    ["tg", "Салом! Мо барои ҳамкорӣ бо ширкати шумо омода ҳастем ва ташаккур барои ҷавоб."],
    ["ky", "Саламатсызбы! Биз сиздин компания менен кызматташууга даярбыз, рахмат жана ийгилик."],
    ["tk", "Salam! Biz siziň kompaniýaňyz bilen hyzmatdaşlyk etmäge taýýar, sag boluň."],
    ["km", "សួស្តី យើងចាប់អារម្មណ៍ក្នុងការសហការជាមួយក្រុមហ៊ុនរបស់អ្នក"],
    ["lo", "ສະບາຍດີ ພວກເຮົາສົນໃຈຮ່ວມມືກັບບໍລິສັດຂອງທ່ານ"],
    ["ar", "مرحبا، نحن مهتمون بالتعاون مع شركتكم ونود مناقشة الشروط في هذا الأسبوع."],
    ["ur", "السلام علیکم، ہم آپ کی کمپنی کے ساتھ کام کرنے میں دلچسپی رکھتے ہیں اور شکریہ۔"],
    ["hi", "नमस्ते, हम आपकी कंपनी के साथ काम करने में रुचि रखते हैं और यह बहुत अच्छा है।"],
    ["ne", "नमस्ते, हामी तपाईंको कम्पनीसँग काम गर्न इच्छुक छौं र यो राम्रो हुन्छ।"],
    ["bn", "নমস্কার, আমরা আপনার কোম্পানির সাথে কাজ করতে আগ্রহী।"],
    ["ta", "வணக்கம், உங்கள் நிறுவனத்துடன் இணைந்து பணியாற்ற ஆர்வமாக உள்ளோம்."],
    ["te", "నమస్కారం, మీ కంపెనీతో కలిసి పనిచేయడానికి మేము ఆసక్తిగా ఉన్నాము."],
    ["zh", "您好，我们很高兴与贵公司合作，期待您的回复。"],
    ["ja", "こんにちは、貴社との協力に興味があります。よろしくお願いします。"],
    ["ko", "안녕하세요, 귀사와 협력하는 데 관심이 있습니다."],
    ["fr", "Bonjour, nous sommes intéressés par une collaboration avec votre entreprise et nous vous remercions."],
    ["es", "Hola, estamos interesados en colaborar con su empresa y le damos las gracias por la respuesta."],
    ["de", "Hallo, wir sind an einer Zusammenarbeit mit Ihrem Unternehmen interessiert und danke für die Antwort."],
    ["pt", "Olá, estamos interessados em uma parceria com a sua empresa e obrigado pela resposta, não há pressa."],
    ["en", "Hello, we are interested in working with your company and would like to schedule a call this week."],
  ];
  for (const [lang, text] of samples) {
    it(`detects ${languageName(lang)}`, () => {
      const d = detectLanguage(text);
      expect(d.language).toBe(lang);
      expect(d.confidence).toBeGreaterThan(0.3);
    });
  }
  it("reports low confidence for very short or ambiguous text", () => {
    expect(detectLanguage("ok").confidence).toBeLessThan(0.5);
    expect(detectLanguage("12345 !!!").language).toBe("und");
  });
  it("derives RTL from the script, not from a language list", () => {
    expect(isRtl("ar")).toBe(true);
    expect(isRtl("ur")).toBe(true);
    expect(isRtl("he")).toBe(true);
    expect(isRtl("ru")).toBe(false);
    expect(isRtl("km")).toBe(false);
  });
});

describe("translation with preservation", () => {
  it("protects names, numbers, emails and URLs and restores them", () => {
    const p = protect("Contact Naveen at naveen@carpediem.example about HappyGut 140B: 30 capsules, see https://carpediem.example/hg", { keep: ["HappyGut 140B", "Naveen"] });
    expect(p.text).not.toContain("HappyGut");
    expect(p.text).not.toContain("naveen@");
    const back = restore(p.text, p.tokens);
    expect(back.missing).toEqual([]);
    expect(back.text).toContain("HappyGut 140B");
    expect(back.text).toContain("https://carpediem.example/hg");
  });

  it("keeps original + translation and flags high-impact terminology for review", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx);
    const r = await translateText(ctx, "Мы хотим эксклюзивный договор и регистрацию продукта HappyGut 140B в Узбекистане.", "en", { glossary: { keep: ["HappyGut 140B"] } });
    expect(r.original).toContain("эксклюзивный");
    expect(r.translated).toContain("HappyGut 140B");
    expect(r.sourceLanguage).toBe("ru");
    expect(r.needsReview).toBe(true);
    expect(r.reviewReasons.join(" ")).toMatch(/high-impact/);
  });

  it("flags dropped placeholders", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx);
    setAdapterFactory((c, id) => ({ id, test: async () => ({ ok: true, detail: "" }), translate: async (m, req) => ({ texts: req.texts.map(() => "lost the number"), usage: { costUsd: 0 }, model: m.id }) }));
    const r = await translateText(ctx, "Please send 500 units to sales@pharma.uz", "ru", { source: "en" });
    expect(r.needsReview).toBe(true);
    expect(r.reviewReasons.join(" ")).toMatch(/Protected values/);
  });

  it("discovers languages from connected providers and answers honestly about voice", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx);
    await refreshLanguageRegistry(ctx);
    const all = await listLanguages(ctx);
    expect(all.find((l) => l.id === "km")?.text).toContain("google-translate");
    const km = await languageSupport(ctx, "km");
    expect(km.text).toBe(true);
    expect(km.voiceOut).toBe(false);
    expect(km.message).toMatch(/no reliable synthetic voice/);
  });
});
