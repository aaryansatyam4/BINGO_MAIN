# BINGO 3.0 — AI business operating system

BINGO is one interface for running and growing the business: you give it an objective, and it plans and carries out the work across AI models, Google Workspace, GitHub, Vercel, Telegram and telephony. It asks you before anything important happens, and it never reports an action as done unless the provider confirmed it.

```
 Ask BINGO ──► Planner ──► durable workflow (DB) ──► 24/7 runner (Vercel Cron / worker)
                 │                 │
                 │                 ├─ BINGO AI ENGINE  (Claude · OpenAI · Gemini · Translate · DeepL · custom)
                 │                 ├─ STUDIO   brand kits · approved claims · creatives · edits
                 │                 ├─ BUILD    Next.js sites · sandbox tests · GitHub PR · Vercel preview/prod
                 │                 ├─ GLOBAL   verified research · CRM · multilingual outreach · replies
                 │                 ├─ MEETINGS slots across time zones · Calendar + Meet · briefs
                 │                 ├─ SPEAK    escalation policy · Twilio/Exotel priority calls
                 │                 ├─ SKILLS   learned preferences & event workflows
                 │                 └─ REPORTS  research + CRM data → charts → PDF/HTML → Gmail/Telegram
                 │
                 └─ deterministic policy engine: approvals bound to payload hashes, limits, emergency stop
 Google Sheets (editable data) · company task sheet (ISSHAAN Task System) · knowledge graph · activity log
```

## What is in this repository

| Module | Where | What it does |
|---|---|---|
| **BINGO AI ENGINE** | `src/ai/` | Provider marketplace (Settings → AI Models): credentials, a connection test, capabilities, monthly limits, preferred and fallback models. It routes each task by capability, cost, latency, measured reliability and workspace permissions. When a capability needs another provider, it says which one. Claude is called through the official `@anthropic-ai/sdk`: structured outputs, web search with sources, a tool-use loop for coding, and refusal fallbacks. |
| **Policy & security** | `src/core/policy.ts`, `vault.ts`, `src/security/` | Every external action calls `authorize()` right before it runs. Approvals are bound to a SHA-256 of the exact payload and can be used once, so content changed after approval needs approval again. Standing approvals are narrow and time-boxed. Production deploys, domain changes, external calls and skill activation can never be switched to automatic. Also: the emergency stop, AES-256-GCM credential vault with revocation, prompt-injection sanitising of untrusted content, and an SSRF guard. |
| **BINGO STUDIO** | `src/studio/` | Brand kits (logo, colours, fonts, tone, guidelines, products, approved claims, facts, regulatory rules). The approved-claims compliance checker blocks medical claims, testimonials, unapproved certifications, invented numbers and prices. AI images are used only for backgrounds. Text, logo and the approved packshot are separate layers in an SVG composition, so the product image is never changed and headlines stay crisp. Text contrast is guaranteed by WCAG worst-case maths with an automatic scrim. Covers 7 formats, natural-language edits, versions, approval, and SVG/PNG export. |
| **BINGO BUILD** | `src/build/` | Turns a request into a spec, then approved copy and translations, then a complete Next.js + TypeScript project: SEO metadata, JSON-LD, sitemap, robots, privacy page, accessible lead form, RTL support, reduced motion, and its own tests. A security scan checks dependency allow-list, `eval`/process spawning, secret access and hard-coded keys. Install, typecheck, build and tests run in **Vercel Sandbox** (a microVM with no BINGO credentials and egress limited to npm and Google Fonts). An AI repair loop fixes failures. Then a GitHub repo, branch, commit and PR, a Vercel preview with verification, production **only after approval** (the exact approved file digest), rollback and domains. |
| **BINGO GLOBAL** | `src/global/` | Web research with sources. Companies not backed by a source are dropped. The official website is fetched to verify name and contact, and leads are de-duplicated by domain and name. Covers the CRM pipeline (Researching → … → Active), relevance scoring, Google Sheets two-way sync and the knowledge graph. Outreach is drafted natively in the recipient's language, with a translation for you. Compliance rules: no prices, exclusivity or registrations. Batch approval, then Gmail send with real message and thread IDs, daily and per-domain limits, spacing, opt-out footer plus List-Unsubscribe, a suppression list, and no duplicate introductions. Replies are monitored: language detected, translated, classified by a schema-constrained model, and every action chosen by code. |
| **Meetings** | `src/calendar/` | IANA time-zone maths, and slots inside both parties' working hours that avoid your busy times. Times are shown in the contact's zone and language, formatted by code. The reply is read to pick the slot. Then an approval-gated Google Calendar event with a Meet link and real invitations. A meeting counts as "confirmed" only when Google Calendar shows the guest accepted. Also: briefs, 24-hour and 1-hour Telegram reminders, follow-up tasks after the meeting, and a Meetings sheet. |
| **BINGO SPEAK** | `src/speak/` | Escalation policy covering LOW to CRITICAL channels, category severities, VIPs, quiet hours, do-not-disturb, per-incident and daily call limits, monthly call budget and verified-only calls. You can edit it in plain language ("call me for emergencies, Telegram for routine"). Twilio calls use the professional script and speech/keypad menu, with signed webhooks. Exotel is supported too. If you don't acknowledge, BINGO follows up and then falls back. Your decisions are recorded, but **BINGO never commits on your behalf**. |
| **BINGO SKILLS** | `src/skills/` | Turns "Whenever / every time / always…" into validated preferences or event workflows (`meeting.confirmed`, `product.launched`, `deployment.production.live`, …). Skills can only use catalogued steps, can't touch approvals, get a new version when changed, and improve from feedback. |
| **Orchestrator** | `src/orchestrator/` | Planner (rules for common requests, AI composition from the step catalogue otherwise). Durable dependency graph: approvals, waits, retries with back-off, pause, cancel, modify, skip and retry, per-step AI cost. Scheduler jobs: workflows, outbox, inbox, scheduling, meeting status and reminders, incident follow-ups, sheet pull, recurring reports. |
| **Reports** | `src/reports/` | Research plus CRM data, written in any language, with SVG charts. PDF via pdf-lib for Latin, Cyrillic and Greek. For scripts that need shaping it says so and delivers HTML. Delivered to Gmail and Telegram with real IDs, plus recurring templates. |
| **Company task sheet** | `src/integrations/tasks.ts` | Creates follow-up tasks in the **existing ISSHAAN Task System** through its own Apps Script API (login → `createTask`). The task sheet's schema, formulas, reminders and approvals are untouched. Each task carries `[BINGO:<ref>]`, so tasks are never duplicated, even if BINGO's database is reset. |
| **UI** | `app/` | Home (Ask BINGO, decisions, progress, connections, emergency stop), live execution plan, Studio, Build, Global, Speak, Skills, Activity and Settings. Works at phone width. |

## Tests

```bash
npm run typecheck && npm test        # 103 tests: 101 run by default, 2 need the flag below
BINGO_E2E_BUILD=1 npx vitest run tests/landing-build.e2e.test.ts   # real npm install → tsc → next build → site tests
```

The tests run every module against `tests/fakes/world.ts`, a fake of Google, GitHub, Vercel, Telegram, Twilio and company websites. It uses the real URL shapes and records every request, so assertions check real side effects (sent MIME, commit trees, deployment targets and file digests, Calendar invitations, sheet rows). They include the six acceptance tests from the brief:

1. **Landing page**: copy → code → sandbox checks → GitHub PR → Vercel preview URL, with production only after approval (`tests/build.test.ts`, `tests/orchestrator.test.ts`).
2. **Uzbekistan distributors + Russian introductions**: verified leads in Sheets, nothing sent before approval, real Gmail IDs after it (`tests/global.test.ts`).
3. **Meeting**: the reply picks a slot → approved Calendar invitation with Meet → acceptance read from Google → CRM stage + follow-up task (`tests/calendar.test.ts`).
4. **Urgent decision**: HIGH goes to Telegram with options, CRITICAL places a real Twilio call, with limits and quiet hours respected (`tests/speak.test.ts`).
5. **Reusable skill**: "Every time we launch a new product…" becomes a validated event workflow (`tests/skills.test.ts`).
6. **Browser closed**: a fresh worker process on the same database continues the work, and history shows the real Gmail IDs (`tests/orchestrator.test.ts`).

`tests/tasks.integration.test.ts` starts the **real ISSHAAN Apps Script code** with its mock server (from `../ISSHAAN_TASK`). It proves tasks are created, routed and never duplicated, and that the task system's own permission rules are respected.

## Deploy (Vercel)

1. Import this repository in Vercel. Add a **Postgres** database (Vercel Postgres, Neon or Supabase) and set `DATABASE_URL`.
2. Set the environment variables from `.env.example`. You need at least `BINGO_MASTER_KEY` (`openssl rand -hex 32`), `BINGO_OWNER_PASSWORD`, `CRON_SECRET` and `BINGO_PUBLIC_URL`.
3. Deploy. `vercel.json` registers a cron for `/api/cron/tick` every minute (per-minute cron needs a paid Vercel plan). Without it, run `npm run worker` on any always-on machine (`BINGO_URL`, `CRON_SECRET`), or turn on `.github/workflows/heartbeat.yml` (every 5 minutes).
4. Sign in and open **Settings**:
   - **AI Models**: add your Anthropic key (Claude handles reasoning, research, code and copy). Add OpenAI or Gemini for images, and Google Translate or DeepL for broad language coverage. Then press *Discover languages*.
   - **Google**: create an OAuth client (Web), add the redirect URI shown, then *Authorize Google*. Link a spreadsheet for each dataset (Leads, Outreach, Meetings, Deployments, Creatives, Reports).
   - **Company task sheet**: the ISSHAAN Apps Script web-app URL plus a staff login for BINGO. Use an admin account, or give the BINGO account *Allow seniors* in the task system's Permissions page, so it can assign follow-ups to the right people. Then set who gets which kind of follow-up.
   - **GitHub**: OAuth app or fine-grained token. **Vercel**: access token (and team), a protection-bypass secret so BINGO can verify protected previews, and a **Sandbox project ID**, which is needed to test generated code.
   - **Telegram**: a **separate bot** from the one ISSHAAN uses. Set the chat ID and register the webhook to approve from Telegram.
   - **Phone calls**: Twilio (number, SID, token) or Exotel, plus your phone number in Profile.
5. Open **Studio → Brand kits**. The Carpediem kit starts as a *draft*: only the brand direction is filled in, and **no product claims or descriptions are invented**. Add the approved claims, facts and packshots for SleepTime and HappyGut 140B, then mark the kit verified.

Local development: `cp .env.example .env.local`, then `npm install`, then `npm run dev`. Without `DATABASE_URL`, data is stored in `./.data`. Set `BINGO_ALLOW_LOCAL_SANDBOX=1` to test generated sites locally (dev only: no network isolation).

## Honest limits

- BINGO stores credentials but **can't verify a provider until you add real keys**. Every capability without a provider shows up as a *blocked* step with the reason, and is never faked.
- "Sent" means Gmail accepted the message (`users.messages.send` returned an ID). Inbox delivery isn't observable.
- Prices for non-Anthropic models are labelled *estimate*. Edit them to match your contracts.
- PDF reports cover Latin, Cyrillic and Greek scripts. Devanagari, Arabic, Khmer and others are delivered as HTML (printable to PDF) because the built-in engine can't shape those scripts.
- Voice support depends on what your telephony provider supports for each language. When a language isn't reliable, BINGO says so.
- New *executable* abilities aren't written into BINGO at runtime. Skills compose the catalogued steps. New code goes through BINGO BUILD (sandbox, tests, PR) and needs your approval to activate.
