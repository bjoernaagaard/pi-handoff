import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerHandoff } from "./handoff.ts";
import type { HandoffState } from "./handoff.ts";
import { reconcile } from "./reconcile.ts";
import { CUSTOM_TYPES, findAnchor } from "./records.ts";
import type { AnchorRecord, CompactionAllowedRecord } from "./records.ts";

/**
 * compaction_policy (H2). Threshold compaction would fold the fixed prefix into a summary (F19), so
 * it is cancelled and the user is told to hand off. Overflow and manual compaction go ahead, because
 * cancelling overflow would stall the turn.
 */
const registerCompactionPolicy = (pi: ExtensionAPI): void => {
  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason === "threshold") {
      ctx.ui.notify(
        "pi-handoff: the context is nearly full. Automatic compaction was skipped. Run /handoff <task> to continue from the anchor.",
        "warning"
      );

      return { cancel: true };
    }

    const allowed: CompactionAllowedRecord = {
      reason: event.reason,
      version: 1,
    };

    pi.appendEntry(CUSTOM_TYPES.compactionAllowed, allowed);

    return { cancel: false };
  });
};

/** Demonstration hook: PI_HANDOFF_CAPTURE=<dir> saves every provider payload as <dir>/<n>.json. */
const registerCapture = (pi: ExtensionAPI): void => {
  const captureDir = process.env.PI_HANDOFF_CAPTURE;

  if (captureDir === undefined || captureDir.length === 0) {
    return;
  }

  pi.on("before_provider_request", (event) => {
    mkdirSync(captureDir, { recursive: true });

    const count = readdirSync(captureDir).filter((name) =>
      name.endsWith(".json")
    ).length;

    writeFileSync(
      path.join(captureDir, `${count + 1}.json`),
      JSON.stringify(event.payload, null, 2)
    );
  });
};

export default function piHandoff(pi: ExtensionAPI): void {
  const state: HandoffState = {
    pendingHandoffId: undefined,
    running: undefined,
  };

  registerHandoff(pi, state);
  registerCapture(pi);
  registerCompactionPolicy(pi);

  pi.on("session_start", async (event, ctx) => {
    const isFreshStart = event.reason === "startup" || event.reason === "new";

    if (isFreshStart && !findAnchor(ctx.sessionManager.getEntries())) {
      const anchor: AnchorRecord = {
        createdAt: new Date().toISOString(),
        version: 1,
      };

      pi.appendEntry(CUSTOM_TYPES.anchor, anchor);
    }

    ctx.ui.notify("pi-handoff loaded", "info");
    await reconcile(pi, state, ctx);
  });
}
