import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { sendContinuation } from "./handoff.ts";
import type { HandoffState } from "./handoff.ts";
import { collectHandoffs, findAnchor } from "./records.ts";
import type { DestinationRecord, IntentRecord, Recorded } from "./records.ts";

type SessionView = ExtensionContext["sessionManager"];

/** One finding of the restart reconciler, derived from records each time (idempotence_rule). */
export type Recovery =
  | { kind: "stale-intent"; handoffId: string }
  | {
      kind: "send-continuation";
      handoff: {
        handoffId: string;
        intent: Recorded<IntentRecord>;
        destination: Recorded<DestinationRecord>;
      };
    }
  | {
      kind: "continuation-not-at-leaf";
      handoffId: string;
      destinationId: string;
    }
  | { kind: "orphans"; rootIds: string[] };

/**
 * Children of the anchor that belong to no handoff: not a destination, not on the path to any
 * archived source leaf, and not the work that started the session. They appear when something is
 * appended under the anchor before a destination.
 */
export const findOrphanRoots = (
  entries: readonly SessionEntry[],
  sessionManager: SessionView
): string[] => {
  const anchor = findAnchor(entries);

  if (!anchor) {
    return [];
  }

  const legitimate = new Set<string>();

  for (const { destination } of collectHandoffs(entries).values()) {
    if (!destination) {
      continue;
    }

    legitimate.add(destination.entry.id);
    const path = sessionManager.getBranch(destination.record.sourceLeafId);
    const anchorIndex = path.findIndex((entry) => entry.id === anchor.id);
    const anchorChild = path.at(anchorIndex + 1);

    if (anchorIndex !== -1 && anchorChild !== undefined) {
      legitimate.add(anchorChild.id);
    }
  }

  const anchorChildren = entries.filter(
    (entry) => entry.parentId === anchor.id
  );

  const originalWork = anchorChildren.at(0);

  if (originalWork !== undefined) {
    legitimate.add(originalWork.id);
  }

  return anchorChildren.flatMap((entry) =>
    legitimate.has(entry.id) ? [] : [entry.id]
  );
};

/**
 * Whether the leaf is the destination, allowing for the model_change and thinking_level_change
 * entries Pi appends at startup when the restored branch has no messages (F35).
 */
const isAtLeaf = (destinationId: string, branch: readonly SessionEntry[]) => {
  const index = branch.findIndex((entry) => entry.id === destinationId);

  return (
    index !== -1 &&
    branch
      .slice(index + 1)
      .every(
        (entry) =>
          entry.type === "model_change" ||
          entry.type === "thinking_level_change"
      )
  );
};

export const planRecovery = (sessionManager: SessionView): Recovery[] => {
  const entries = sessionManager.getEntries();
  const branch = sessionManager.getBranch();
  const plan: Recovery[] = [];

  for (const handoff of collectHandoffs(entries).values()) {
    const { cancel, continuation, destination, handoffId, intent } = handoff;

    if (!intent || cancel || continuation) {
      continue;
    }

    if (!destination) {
      plan.push({ handoffId, kind: "stale-intent" });
    } else if (isAtLeaf(destination.entry.id, branch)) {
      plan.push({
        handoff: { destination, handoffId, intent },
        kind: "send-continuation",
      });
    } else {
      plan.push({
        destinationId: destination.entry.id,
        handoffId,
        kind: "continuation-not-at-leaf",
      });
    }
  }

  const rootIds = findOrphanRoots(entries, sessionManager);

  if (rootIds.length > 0) {
    plan.push({ kind: "orphans", rootIds });
  }

  return plan;
};

/**
 * recovery_on_session_start. Runs on every session start; a second run appends nothing because the
 * continuation it sent is now on record. Print and rpc modes append the continuation without a turn:
 * starting one here would make Pi reject the prompt the caller is about to send.
 */
export const reconcile = async (
  pi: ExtensionAPI,
  state: HandoffState,
  ctx: ExtensionContext
): Promise<void> => {
  const plan = planRecovery(ctx.sessionManager);
  let resend: Extract<Recovery, { kind: "send-continuation" }> | undefined;

  for (const finding of plan) {
    switch (finding.kind) {
      case "stale-intent": {
        ctx.ui.notify(
          `pi-handoff: handoff ${finding.handoffId} stopped before navigation. Run /handoff resume ${finding.handoffId} to continue it.`,
          "warning"
        );
        break;
      }

      case "send-continuation": {
        resend = finding;
        break;
      }

      case "continuation-not-at-leaf": {
        ctx.ui.notify(
          `pi-handoff: handoff ${finding.handoffId} has destination ${finding.destinationId} but no continuation, and the session leaf is elsewhere. Nothing was changed.`,
          "warning"
        );
        break;
      }

      case "orphans": {
        ctx.ui.notify(
          `pi-handoff: entries ${finding.rootIds.join(", ")} sit under the anchor outside any handoff. Nothing was changed. handoff_search marks them orphaned.`,
          "warning"
        );
        break;
      }

      default: {
        const unreachable: never = finding;
        throw new Error(`Unknown recovery ${JSON.stringify(unreachable)}`);
      }
    }
  }

  // Only the destination at the leaf qualifies, so there is at most one.
  if (resend) {
    const { destination, handoffId, intent } = resend.handoff;
    ctx.ui.notify(
      `pi-handoff: sending the missing continuation for handoff ${handoffId}.`,
      "info"
    );
    await sendContinuation(
      pi,
      state,
      intent.record,
      destination.record,
      destination.entry.id,
      { triggerTurn: ctx.mode === "tui" }
    );
  }
};
