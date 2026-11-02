/**
 * Offline language detection: Unicode script analysis plus distinctive letters
 * and function words inside a script. Returns a confidence so low-confidence
 * results can be confirmed by a provider or a human. This is the first pass;
 * it is not a fixed list of supported languages (see registry.ts).
 */
export interface Detection {
  language: string; // BCP-47 ("und" if unknown)
  script: string; // ISO 15924
  confidence: number; // 0..1
  alternatives: { language: string; score: number }[];
}

const SCRIPTS: [string, RegExp][] = [
  ["Cyrl", /\p{Script=Cyrillic}/u],
  ["Latn", /\p{Script=Latin}/u],
  ["Arab", /\p{Script=Arabic}/u],
  ["Hebr", /\p{Script=Hebrew}/u],
  ["Deva", /\p{Script=Devanagari}/u],
  ["Beng", /\p{Script=Bengali}/u],
  ["Taml", /\p{Script=Tamil}/u],
  ["Telu", /\p{Script=Telugu}/u],
  ["Knda", /\p{Script=Kannada}/u],
  ["Mlym", /\p{Script=Malayalam}/u],
  ["Gujr", /\p{Script=Gujarati}/u],
  ["Guru", /\p{Script=Gurmukhi}/u],
  ["Orya", /\p{Script=Oriya}/u],
  ["Sinh", /\p{Script=Sinhala}/u],
  ["Khmr", /\p{Script=Khmer}/u],
  ["Laoo", /\p{Script=Lao}/u],
  ["Thai", /\p{Script=Thai}/u],
  ["Mymr", /\p{Script=Myanmar}/u],
  ["Hang", /\p{Script=Hangul}/u],
  ["Hira", /\p{Script=Hiragana}|\p{Script=Katakana}/u],
  ["Hani", /\p{Script=Han}/u],
  ["Grek", /\p{Script=Greek}/u],
  ["Armn", /\p{Script=Armenian}/u],
  ["Geor", /\p{Script=Georgian}/u],
  ["Ethi", /\p{Script=Ethiopic}/u],
  ["Mong", /\p{Script=Mongolian}/u],
  ["Tibt", /\p{Script=Tibetan}/u],
];

/** Script → language when the script is (nearly) unique to one language. */
const SINGLE: Record<string, string> = {
  Beng: "bn",
  Taml: "ta",
  Telu: "te",
  Knda: "kn",
  Mlym: "ml",
  Gujr: "gu",
  Guru: "pa",
  Orya: "or",
  Sinh: "si",
  Khmr: "km",
  Laoo: "lo",
  Thai: "th",
  Mymr: "my",
  Hang: "ko",
  Hira: "ja",
  Grek: "el",
  Armn: "hy",
  Geor: "ka",
  Ethi: "am",
  Hebr: "he",
  Tibt: "bo",
};

interface Profile {
  lang: string;
  letters?: RegExp; // distinctive characters
  words: string[]; // frequent function words
}

const CYRILLIC: Profile[] = [
  { lang: "ru", letters: /[ыэъё]/giu, words: ["и", "в", "не", "на", "что", "с", "по", "это", "мы", "вы", "для", "как", "здравствуйте", "спасибо", "компания", "наш", "ваш", "о", "к", "от", "будем", "рады"] },
  { lang: "uk", letters: /[іїєґ]/giu, words: ["і", "та", "що", "це", "для", "ми", "ви", "дякую", "будь", "ласка", "наша"] },
  { lang: "uz-Cyrl", letters: /[ўқғҳ]/giu, words: ["ва", "билан", "учун", "бу", "биз", "сиз", "ҳам", "рахмат", "рақмат"] },
  { lang: "tg", letters: /[ӣӯҷҳқғ]/giu, words: ["ва", "дар", "бо", "барои", "ин", "мо", "шумо", "аст", "ташаккур"] },
  { lang: "ky", letters: /[ңөү]/giu, words: ["жана", "менен", "үчүн", "бул", "биз", "сиз", "рахмат", "экен"] },
  { lang: "kk", letters: /[әіңғүұқөһ]/giu, words: ["және", "мен", "үшін", "бұл", "біз", "сіз", "рахмет"] },
  { lang: "bg", letters: /[щъ]/giu, words: ["и", "на", "за", "от", "се", "да", "благодаря", "това"] },
  { lang: "sr", letters: /[ђћџљњј]/giu, words: ["и", "је", "да", "за", "хвала"] },
  { lang: "mn", letters: /[өү]/giu, words: ["бол", "байна", "болон", "баярлалаа"] },
];

const LATIN: Profile[] = [
  { lang: "en", words: ["the", "and", "of", "to", "is", "in", "for", "we", "you", "with", "our", "your", "are", "please", "thank", "would", "like", "this", "that"] },
  { lang: "fr", letters: /[àâçèéêëîïôûùüÿœ]/giu, words: ["le", "la", "les", "et", "de", "des", "est", "nous", "vous", "pour", "avec", "une", "merci", "bonjour", "notre"] },
  { lang: "es", letters: /[ñ¿¡áéíóú]/giu, words: ["el", "la", "los", "y", "de", "es", "para", "con", "nosotros", "usted", "gracias", "hola", "nuestra", "una", "que"] },
  { lang: "pt", letters: /[ãõçâêôáéíóú]/giu, words: ["o", "a", "os", "e", "de", "é", "para", "com", "nós", "você", "obrigado", "olá", "nossa", "uma", "não"] },
  { lang: "de", letters: /[äöüß]/giu, words: ["der", "die", "das", "und", "ist", "nicht", "wir", "sie", "für", "mit", "danke", "unser", "ein", "eine"] },
  { lang: "it", words: ["il", "la", "e", "di", "che", "per", "con", "siamo", "grazie", "nostro", "una", "sono"] },
  { lang: "uz", letters: /(o['ʻ‘’]|g['ʻ‘’]|sh|ch)/giu, words: ["va", "bilan", "uchun", "bu", "biz", "siz", "ham", "rahmat", "kompaniya", "bizning", "yaxshi", "assalomu", "alaykum"] },
  { lang: "tk", letters: /[ňäöüşçžý]/giu, words: ["we", "bilen", "üçin", "bu", "biz", "siz", "hem", "sag", "boluň", "kompaniýa"] },
  { lang: "tr", letters: /[ğışçöü]/giu, words: ["ve", "bir", "bu", "için", "ile", "biz", "siz", "teşekkür", "ederiz", "değil"] },
  { lang: "id", words: ["dan", "yang", "untuk", "dengan", "kami", "anda", "terima", "kasih", "ini", "itu"] },
  { lang: "vi", letters: /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/giu, words: ["và", "của", "là", "cho", "chúng", "tôi", "bạn", "cảm", "ơn"] },
  { lang: "pl", letters: /[ąćęłńóśźż]/giu, words: ["i", "w", "nie", "na", "się", "jest", "dla", "dziękuję", "nasz"] },
  { lang: "nl", words: ["de", "het", "en", "van", "een", "is", "wij", "u", "voor", "met", "bedankt"] },
];

const ARABIC: Profile[] = [
  { lang: "ur", letters: /[ٹڈڑںےھۓ]/gu, words: ["اور", "کے", "کی", "ہے", "میں", "کا", "آپ", "ہم", "شکریہ"] },
  { lang: "fa", letters: /[پچژگ]/gu, words: ["و", "در", "به", "از", "که", "این", "است", "ما", "شما", "متشکرم", "با"] },
  { lang: "ar", letters: /[ةىءأإ]/gu, words: ["و", "في", "من", "على", "إلى", "أن", "هذا", "نحن", "شكرا", "مع", "عن"] },
];

const DEVANAGARI: Profile[] = [
  { lang: "hi", words: ["है", "के", "में", "की", "और", "का", "को", "हम", "आप", "हैं", "धन्यवाद", "कृपया", "नहीं"] },
  { lang: "ne", words: ["छ", "छन्", "र", "को", "मा", "हो", "हामी", "तपाईं", "धन्यवाद", "गर्न", "हुन्छ", "भएको"] },
  { lang: "mr", words: ["आहे", "आणि", "च्या", "मध्ये", "आम्ही", "तुम्ही", "धन्यवाद", "नाही"] },
];

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{M}'ʻ‘’]+/u)
    .filter(Boolean);
}

function scoreProfiles(text: string, profiles: Profile[]) {
  const toks = tokens(text);
  const set = new Map<string, number>();
  for (const t of toks) set.set(t, (set.get(t) ?? 0) + 1);
  const scores = profiles.map((p) => {
    let s = 0;
    for (const w of p.words) s += set.get(w) ?? 0;
    const letters = p.letters ? (text.match(p.letters) ?? []).length : 0;
    s = s / Math.max(1, toks.length) + Math.min(letters, 12) * 0.04;
    return { language: p.lang, score: s };
  });
  return scores.sort((a, b) => b.score - a.score);
}

export function dominantScript(text: string): { script: string; share: number } {
  const counts = new Map<string, number>();
  let letters = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    for (const [code, re] of SCRIPTS) {
      if (re.test(ch)) {
        counts.set(code, (counts.get(code) ?? 0) + 1);
        break;
      }
    }
  }
  if (!letters) return { script: "Zyyy", share: 0 };
  // Kana anywhere means Japanese even when Han dominates.
  if ((counts.get("Hira") ?? 0) > 0 && (counts.get("Hani") ?? 0) > 0) counts.set("Hira", (counts.get("Hira") ?? 0) + (counts.get("Hani") ?? 0));
  const [script, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["Zyyy", 0];
  return { script, share: n / letters };
}

export function detectLanguage(text: string): Detection {
  const sample = text.slice(0, 4000);
  const { script, share } = dominantScript(sample);
  const lengthFactor = Math.min(1, tokens(sample).length / 12);
  if (script === "Zyyy") return { language: "und", script, confidence: 0, alternatives: [] };
  if (SINGLE[script]) return { language: SINGLE[script]!, script, confidence: 0.85 * share + 0.15 * lengthFactor, alternatives: [] };
  if (script === "Hani") return { language: "zh", script, confidence: 0.8 * share, alternatives: [{ language: "ja", score: 0.1 }] };

  const profiles = script === "Cyrl" ? CYRILLIC : script === "Latn" ? LATIN : script === "Arab" ? ARABIC : script === "Deva" ? DEVANAGARI : null;
  if (!profiles) return { language: "und", script, confidence: 0.2, alternatives: [] };
  const ranked = scoreProfiles(sample, profiles);
  const [best, second] = ranked;
  if (!best || best.score === 0) {
    const guess = script === "Cyrl" ? "ru" : script === "Arab" ? "ar" : script === "Deva" ? "hi" : "en";
    return { language: guess, script, confidence: 0.3 * lengthFactor, alternatives: ranked.slice(0, 3) };
  }
  const margin = second ? (best.score - second.score) / best.score : 1;
  const confidence = Math.min(0.97, (0.45 + 0.5 * margin) * (0.5 + 0.5 * lengthFactor) * share + 0.05);
  return { language: best.language, script, confidence, alternatives: ranked.slice(1, 4) };
}

/** RTL is a property of the script; derived from the language tag, not from a language list. */
const RTL_SCRIPTS = new Set(["Arab", "Hebr", "Thaa", "Syrc", "Nkoo", "Adlm", "Rohg", "Mand", "Samr"]);

export function scriptOf(lang: string): string {
  try {
    return new Intl.Locale(lang).maximize().script ?? "Latn";
  } catch {
    return "Latn";
  }
}

export function isRtl(lang: string): boolean {
  return RTL_SCRIPTS.has(scriptOf(lang));
}

export function languageName(code: string, inLang = "en"): string {
  try {
    return new Intl.DisplayNames([inLang], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
