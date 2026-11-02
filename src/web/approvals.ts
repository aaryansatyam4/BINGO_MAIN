import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { decideApproval, type Approval } from "@/core/policy";
import { errorMessage } from "@/core/util";
import { requestSendApproval, sendApproved } from "@/global/outreach";
import { createCalendarInvite } from "@/calendar/meetings";
import { connectDomain, rollback } from "@/build/developer";
import { runWorkflows } from "@/orchestrator/workflow";

/**
 * Owner decision → continue the exact action that was approved. Workflow steps
 * resume through the runner; standalone actions are executed here. Either way
 * the action re-checks the approval against its payload hash before running.
 */
export async function decideAndContinue(ctx: Ctx, id: string, decision: "approved" | "rejected", via: string, note?: string): Promise<{ approval: Approval; result: string }> {
  const approval = await decideApproval(ctx, id, decision, via, note);
  if (decision === "rejected") return { approval, result: "Rejected — nothing was done." };
  try {
    if (approval.workflowId) {
      await runWorkflows(ctx, 25_000);
      return { approval, result: "Approved — the workflow is continuing." };
    }
    const p = approval.payload as Record<string, unknown>;
    switch (approval.kind) {
      case "email.send.initial":
      case "email.send.reply": {
        const ids = ((p.messages as { id: string }[]) ?? []).map((m) => m.id);
        await requestSendApproval(ctx, ids, { approvalId: approval.id });
        const r = await sendApproved(ctx, ids);
        return { approval, result: `Submitted to Gmail: ${r.sent.length}${r.deferred.length ? `, ${r.deferred.length} queued by sending limits` : ""}${r.failed.length ? `, ${r.failed.length} failed` : ""}.` };
      }
      case "calendar.event.create": {
        const r = await createCalendarInvite(ctx, String(p.meetingId), { approvalId: approval.id });
        return { approval, result: r.status === "invited" ? "Calendar invitation sent." : `Invitation: ${r.status}` };
      }
      case "deploy.rollback": {
        await rollback(ctx, String(p.projectId), String(p.to), approval.id);
        return { approval, result: "Rolled back." };
      }
      case "domain.change": {
        const r = await connectDomain(ctx, String(p.projectId), String(p.domain), approval.id);
        return { approval, result: r.status === "done" ? `Domain added${"verified" in r && !r.verified ? " — add the DNS records shown in Build to verify it" : ""}.` : r.status };
      }
      default:
        return { approval, result: "Approved." };
    }
  } catch (e) {
    await logActivity(ctx, { actor: "bingo", action: "approval.execute.error", summary: `Approved “${approval.title}” but it could not be completed: ${errorMessage(e)}`, level: "error" });
    return { approval, result: `Approved, but the action failed: ${errorMessage(e)}` };
  }
}
