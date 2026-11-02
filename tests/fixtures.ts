import { googleExchangeCode } from "@/integrations/google";
import { World } from "./fakes/world";
import type { testCtx } from "./helpers";

export async function connectGoogle(ctx: ReturnType<typeof testCtx>) {
  process.env.GOOGLE_CLIENT_ID = "cid";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  await ctx.vault.setJson("global", "google", { refresh_token: "1//rt", email: "owner@carpediem.example" });
  void googleExchangeCode;
}

export function uzWorld() {
  const world = new World();
  world.sites.set("https://pharmauz.example", { status: 200, html: "<html><title>PharmaUz Distribution LLC</title><body>PharmaUz Distribution — nationwide pharmacy distribution. Contact: info@pharmauz.example</body></html>" });
  world.sites.set("https://medline.example", { status: 200, html: "<html><body>Medline Trade — wholesale. Call +998 71 000 00 00</body></html>" });
  world.sites.set("https://deadco.example", { status: 503, html: "down" });
  return world;
}

export const UZ_RESEARCH = {
  research: {
    text: "PharmaUz Distribution LLC (Tashkent) distributes OTC and supplements, https://pharmauz.example, info@pharmauz.example. Medline Trade (Samarkand) https://medline.example, sales@medline.example. DeadCo https://deadco.example",
    sources: [
      { url: "https://pharmauz.example", title: "PharmaUz" },
      { url: "https://medline.example/about", title: "Medline" },
      { url: "https://deadco.example", title: "DeadCo" },
    ],
  },
  candidates: [
    { company: "PharmaUz Distribution LLC", website: "https://pharmauz.example", city: "Tashkent", description: "Nationwide distributor of OTC medicines and dietary supplements.", portfolio: "OTC, supplements", emails: ["info@pharmauz.example"], phones: [], sourceUrls: ["https://pharmauz.example"] },
    { company: "Medline Trade", website: "https://medline.example", city: "Samarkand", description: "Pharmaceutical wholesaler.", portfolio: "Rx, OTC", emails: ["sales@medline.example"], phones: [], sourceUrls: ["https://medline.example/about"] },
    { company: "DeadCo", website: "https://deadco.example", city: "", description: "", portfolio: "", emails: [], phones: [], sourceUrls: ["https://deadco.example"] },
    { company: "Invented Pharma", website: "https://invented.example", city: "", description: "", portfolio: "", emails: ["ceo@invented.example"], phones: [], sourceUrls: ["https://not-in-sources.example"] },
  ],
};

