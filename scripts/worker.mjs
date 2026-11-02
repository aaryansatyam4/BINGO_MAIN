#!/usr/bin/env node
/**
 * BINGO standalone worker — keeps workflows, inbox monitoring, reminders,
 * escalations and recurring reports running 24/7 on any host (VM, Railway,
 * Fly, a spare server) when Vercel Cron is not available on your plan.
 *
 *   BINGO_URL=https://your-bingo.vercel.app CRON_SECRET=... npm run worker
 *
 * It only calls BINGO's authenticated /api/cron/tick endpoint; all work runs
 * inside BINGO with its normal permission checks.
 */
const url = (process.env.BINGO_URL || "http://localhost:3000").replace(/\/$/, "");
const secret = process.env.CRON_SECRET;
const every = Number(process.env.WORKER_INTERVAL_SECONDS || 30) * 1000;
if (!secret) {
  console.error("Set CRON_SECRET (same value as in BINGO).");
  process.exit(1);
}
let running = false;
async function beat() {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    const res = await fetch(`${url}/api/cron/tick`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(90_000) });
    const body = await res.json().catch(() => ({}));
    console.log(new Date().toISOString(), res.status, `${Date.now() - started}ms`, JSON.stringify(body.result ?? body).slice(0, 400));
  } catch (e) {
    console.error(new Date().toISOString(), "tick failed:", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}
console.log(`BINGO worker → ${url} every ${every / 1000}s`);
await beat();
setInterval(beat, every);
