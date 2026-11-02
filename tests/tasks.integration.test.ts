import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompanyTask, listTaskSystemTasks, saveTaskConfig } from "@/integrations/tasks";
import { testCtx } from "./helpers";

/**
 * Integration test against the REAL company task system code (ISSHAAN Task
 * Management Apps Script), run by its own mock server over an in-memory sheet.
 * Proves BINGO creates tasks in the existing system (no replacement) and never
 * duplicates them.
 */
const ISSHAAN = process.env.ISSHAAN_TASK_DIR ?? path.resolve(__dirname, "../../ISSHAAN_TASK");
const available = existsSync(path.join(ISSHAAN, "tests/mock-server.js"));
const PORT = 8790 + Math.floor(Math.random() * 100);
let server: ChildProcess;

(available ? describe : describe.skip)("company Google-Sheets task system (ISSHAAN)", () => {
  beforeAll(async () => {
    server = spawn("node", ["tests/mock-server.js"], { cwd: ISSHAAN, env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" });
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://localhost:${PORT}`);
        if (r.ok) return;
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("mock server did not start");
  }, 20_000);
  afterAll(() => server?.kill());

  it("creates follow-up tasks through the existing API, routed to the right person, without duplicates", async () => {
    const ctx = testCtx(globalThis.fetch.bind(globalThis));
    await saveTaskConfig(ctx, { apiUrl: `http://localhost:${PORT}`, loginId: "aryan", routing: { default: "Aryan Satyam", design_approval: "Ritesh Kr. Dubey", regulatory_verification: "Naveen Gupta" }, defaultLevel: 2 }, "demo123");
    const r1 = await createCompanyTask(ctx, { ref: "project:prj_1:design-approval", kind: "design_approval", title: "Approve SleepTime landing page design", details: "Preview: https://example.vercel.app", deadline: new Date(Date.now() + 2 * 864e5) });
    expect(r1.status).toBe("created");
    expect(r1).toMatchObject({ to: "Ritesh Kr. Dubey" });
    const taskId = (r1 as { taskId: string }).taskId;
    expect(taskId).toMatch(/^T-\d+/);

    // Same reference → no second task (local index).
    const r2 = await createCompanyTask(ctx, { ref: "project:prj_1:design-approval", kind: "design_approval", title: "Approve SleepTime landing page design", details: "" });
    expect(r2).toMatchObject({ status: "exists", taskId });

    // Even with a fresh BINGO database, the tag in the sheet prevents duplicates.
    const fresh = testCtx(globalThis.fetch.bind(globalThis));
    await saveTaskConfig(fresh, { apiUrl: `http://localhost:${PORT}`, loginId: "aryan", routing: { default: "Aryan Satyam", design_approval: "Ritesh Kr. Dubey" }, defaultLevel: 2 }, "demo123");
    const r3 = await createCompanyTask(fresh, { ref: "project:prj_1:design-approval", kind: "design_approval", title: "Approve SleepTime landing page design", details: "" });
    expect(r3).toMatchObject({ status: "exists", taskId });

    const live = await listTaskSystemTasks(ctx);
    const mine = live.filter((t) => t.details.includes("[BINGO:project:prj_1:design-approval]"));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.to).toBe("Ritesh Kr. Dubey");
  });

  it("reports the task system's own permission errors instead of hiding them", async () => {
    const ctx = testCtx(globalThis.fetch.bind(globalThis));
    await saveTaskConfig(ctx, { apiUrl: `http://localhost:${PORT}`, loginId: "riya", routing: { default: "Sonnjay R Singh" }, defaultLevel: 2 }, "demo123");
    const r = await createCompanyTask(ctx, { ref: "x:1", kind: "general", title: "Junior assigning to MD", details: "" });
    expect(r.status).toBe("error");
    expect((r as { message: string }).message).toMatch(/can't|cannot|not allowed|senior|same level/i);
  });

  it("is honest when the task sheet is not connected", async () => {
    const r = await createCompanyTask(testCtx(), { ref: "y", kind: "general", title: "t", details: "" });
    expect(r.status).toBe("not_configured");
  });
});
