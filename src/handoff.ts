import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { continuationMessage } from "./continuation.ts";
import {
  CUSTOM_TYPES,
  collectHandoffs,
  findAnchor,
  orderedDestinations,
} from "./records.ts";
import type {
  CancelReason,
  CancelRecord,
  DestinationRecord,
  IntentRecord,
  ToolCallNote,
} from "./records.ts";

export const RUN_COMMAND = "pi-handoff:run";

type SessionView = ExtensionContext["sessionManager"];

const CONSTRAINT_PREFIX = "- ";

const STALE_ACTION = /^(?<verb>resume|cancel)\s+(?<handoffId>\S+)$/u;

type IntentResult =
  | { ok: true; handoffId: string }
  | { ok: false; reason: string };

type HeldInput = Parameters<ExtensionAPI["sendUserMessage"]>[0];

/** In-memory handoff state. Only the session file is durable; this resets on restart. */
export interface HandoffState {
  /** Set by the handoff tool, consumed by agent_settled. */
  pendingHandoffId: string | undefined;
  /** Set from navigation until the continuation is sent. Input typed meanwhile is held here. */
  running: { handoffId: string; heldInput: HeldInput[] } | undefined;
}

/** The handoff that blocks a new one: recorded but not dispatched, or in progress. */
const activeHandoffId = (state: HandoffState): string | undefined =>
  state.pendingHandoffId ?? state.running?.handoffId;

type PausePoint = "during-navigate" | "after-navigate" | "after-destination";

// Longest delay setTimeout accepts. A pending timer also keeps print mode's process alive.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Demonstration hook (HANDOFF.yaml A5). PI_HANDOFF_PAUSE_AT holds the handoff at one point so a
 * demo can kill Pi there or type into the TUI. during-navigate holds inside navigateTree, while Pi
 * queues typed text (F22). PI_HANDOFF_PAUSE_MS ends the hold early; without it the hold lasts until
 * Pi is killed.
 */
const pauseIfRequested = async (
  point: PausePoint,
  ctx: ExtensionContext
): Promise<void> => {
  if (process.env.PI_HANDOFF_PAUSE_AT !== point) {
    return;
  }

  const requested = Number(process.env.PI_HANDOFF_PAUSE_MS);

  const delay =
    Number.isFinite(requested) && requested >= 0 ? requested : MAX_TIMER_MS;

  ctx.ui.notify(`pi-handoff: paused ${point}`, "warning");
  await sleep(delay);
};

/**
 * Every tool call since the last user message on the branch, with its outcome so far.
 * The handoff tool's own call is left out because its result is the intent itself.
 */
const collectToolCalls = (
  sessionManager: SessionView,
  ownToolCallId: string | undefined
): ToolCallNote[] => {
  const branch = sessionManager.getBranch();

  const lastUserIndex = branch.findLastIndex(
    (entry) => entry.type === "message" && entry.message.role === "user"
  );

  const calls = new Map<string, ToolCallNote>();

  for (const entry of branch.slice(lastUserIndex + 1)) {
    if (entry.type !== "message") {
      continue;
    }

    const { message } = entry;

    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall" && block.id !== ownToolCallId) {
          calls.set(block.id, {
            status: "no-result",
            toolCallId: block.id,
            toolName: block.name,
          });
        }
      }
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);

      if (call) {
        call.status = message.isError ? "error" : "completed";
      }
    }
  }

  return [...calls.values()];
};

const writeIntent = (
  pi: ExtensionAPI,
  sessionManager: SessionView,
  task: string,
  constraints: string[],
  ownToolCallId?: string
): IntentResult => {
  const anchor = findAnchor(sessionManager.getEntries());
  const sourceSessionFile = sessionManager.getSessionFile();

  if (!anchor) {
    return { ok: false, reason: "This session has no pi-handoff anchor." };
  }

  if (sourceSessionFile === undefined || sourceSessionFile.length === 0) {
    return {
      ok: false,
      reason: "Handoff needs a session file. It cannot run with --no-session.",
    };
  }

  const intent: IntentRecord = {
    anchorId: anchor.id,
    constraints,
    handoffId: randomUUID(),
    openToolCalls: collectToolCalls(sessionManager, ownToolCallId),
    sourceSessionFile,
    sourceSessionId: sessionManager.getSessionId(),
    task,
    version: 1,
  };

  pi.appendEntry(CUSTOM_TYPES.intent, intent);

  return { handoffId: intent.handoffId, ok: true };
};

export const appendCancel = (
  pi: ExtensionAPI,
  handoffId: string,
  reason: CancelReason
): void => {
  const cancel: CancelRecord = { handoffId, reason, version: 1 };
  pi.appendEntry(CUSTOM_TYPES.cancelled, cancel);
};

/** `/handoff <task>`: the first line is the task, later lines that start with "- " are constraints. */
const parseHandoffArgs = (args: string) => {
  const [firstLine = "", ...rest] = args.split("\n");

  const constraints = rest
    .map((line) => line.trim())
    .filter((line) => line.startsWith(CONSTRAINT_PREFIX))
    .map((line) => line.slice(CONSTRAINT_PREFIX.length).trim())
    .filter((line) => line.length > 0);

  return { constraints, task: firstLine.trim() };
};

/** Navigates to the anchor. Returns the cancel reason when the handoff cannot continue. */
const navigateToAnchor = async (
  anchorId: string,
  ctx: ExtensionCommandContext
): Promise<CancelReason | undefined> => {
  try {
    const result = await ctx.navigateTree(anchorId, { summarize: false });

    if (result.cancelled) {
      return "tree-cancelled";
    }
  } catch (error) {
    ctx.ui.notify(
      `pi-handoff: navigation failed: ${error instanceof Error ? error.message : String(error)}`,
      "error"
    );

    return "navigate-threw";
  }

  if (ctx.sessionManager.getLeafId() !== anchorId) {
    return "leaf-moved";
  }

  return undefined;
};

const replayHeldInput = (pi: ExtensionAPI, heldInput: readonly HeldInput[]) => {
  for (const content of heldInput) {
    pi.sendUserMessage(content, { deliverAs: "followUp" });
  }
};

/**
 * Lifecycle step 7, also used by restart recovery: send the continuation, then replay held input as
 * follow-ups. With waitForIdle it waits for the continuation turn, so print and rpc runs do not exit
 * before it.
 */
export const sendContinuation = async (
  pi: ExtensionAPI,
  state: HandoffState,
  intent: IntentRecord,
  destination: DestinationRecord,
  destinationId: string,
  options: { triggerTurn: boolean; waitForIdle?: () => Promise<void> }
): Promise<void> => {
  pi.sendMessage(continuationMessage(intent, destination, destinationId), {
    triggerTurn: options.triggerTurn,
  });
  const heldInput = state.running?.heldInput ?? [];
  state.running = undefined;
  replayHeldInput(pi, heldInput);
  await options.waitForIdle?.();
};

/** Lifecycle steps 3 to 7: navigate to the anchor, write the destination, send the continuation. */
const runHandoff = async (
  pi: ExtensionAPI,
  state: HandoffState,
  handoffId: string,
  ctx: ExtensionCommandContext
): Promise<void> => {
  await ctx.waitForIdle();
  const handoffs = collectHandoffs(ctx.sessionManager.getEntries());
  const intent = handoffs.get(handoffId)?.intent;
  const sourceLeafId = ctx.sessionManager.getLeafId();

  if (!intent || sourceLeafId === null) {
    ctx.ui.notify(`pi-handoff: no intent for handoff ${handoffId}.`, "error");

    return;
  }

  const { anchorId } = intent.record;

  const previousDestinationId =
    orderedDestinations(handoffs).at(-1)?.entry.id ?? null;

  state.running = { handoffId, heldInput: [] };
  const cancelReason = await navigateToAnchor(anchorId, ctx);

  if (cancelReason !== undefined) {
    const { heldInput } = state.running;
    state.running = undefined;
    appendCancel(pi, handoffId, cancelReason);
    ctx.ui.notify(
      `pi-handoff: handoff ${handoffId} cancelled (${cancelReason}).`,
      "warning"
    );
    replayHeldInput(pi, heldInput);

    return;
  }

  await pauseIfRequested("after-navigate", ctx);

  const destination: DestinationRecord = {
    handoffId,
    intentEntryId: intent.entry.id,
    previousDestinationId,
    sourceLeafId,
    sourceSessionFile: intent.record.sourceSessionFile,
    sourceSessionId: intent.record.sourceSessionId,
    version: 1,
  };

  pi.appendEntry(CUSTOM_TYPES.destination, destination);
  const destinationId = ctx.sessionManager.getLeafId();

  if (destinationId === null) {
    throw new Error("pi-handoff: the destination entry was not appended");
  }

  await pauseIfRequested("after-destination", ctx);
  await sendContinuation(pi, state, intent.record, destination, destinationId, {
    triggerTurn: true,
    waitForIdle: async () => {
      await ctx.waitForIdle();
    },
  });
};

const resumeHandoff = async (
  pi: ExtensionAPI,
  state: HandoffState,
  handoffId: string,
  ctx: ExtensionCommandContext
): Promise<void> => {
  await ctx.waitForIdle();

  const handoff = collectHandoffs(ctx.sessionManager.getEntries()).get(
    handoffId
  );

  if (!handoff?.intent) {
    ctx.ui.notify(`pi-handoff: no handoff ${handoffId} found.`, "error");

    return;
  }

  if (handoff.destination || handoff.cancel) {
    ctx.ui.notify(
      `pi-handoff: handoff ${handoffId} is already ${handoff.cancel ? "cancelled" : "past navigation"}.`,
      "warning"
    );

    return;
  }

  await runHandoff(pi, state, handoffId, ctx);
};

const cancelHandoff = async (
  pi: ExtensionAPI,
  state: HandoffState,
  handoffId: string,
  ctx: ExtensionCommandContext
): Promise<void> => {
  await ctx.waitForIdle();

  const handoff = collectHandoffs(ctx.sessionManager.getEntries()).get(
    handoffId
  );

  const isBusy = activeHandoffId(state) === handoffId;

  if (!handoff?.intent || handoff.destination || handoff.cancel || isBusy) {
    ctx.ui.notify(
      `pi-handoff: handoff ${handoffId} is not a stale intent, so it cannot be cancelled.`,
      "error"
    );

    return;
  }

  appendCancel(pi, handoffId, "user");
  ctx.ui.notify(`pi-handoff: handoff ${handoffId} cancelled.`, "info");
};

const textResult = (
  text: string,
  outcome: { isError: true } | { terminate: true }
): AgentToolResult<undefined> => ({
  content: [{ text, type: "text" }],
  details: undefined,
  ...outcome,
});

const recordToolHandoff = (
  pi: ExtensionAPI,
  state: HandoffState,
  sessionManager: SessionView,
  toolCallId: string,
  params: { task: string; constraints: string[] }
): AgentToolResult<undefined> => {
  const active = activeHandoffId(state);

  if (active !== undefined) {
    return textResult(`A handoff (${active}) is already in progress.`, {
      isError: true,
    });
  }

  const result = writeIntent(
    pi,
    sessionManager,
    params.task,
    params.constraints,
    toolCallId
  );

  if (!result.ok) {
    return textResult(result.reason, { isError: true });
  }

  state.pendingHandoffId = result.handoffId;

  return textResult(
    `Handoff ${result.handoffId} recorded. Pi continues from the session anchor when this run ends.`,
    { terminate: true }
  );
};

export const registerHandoff = (
  pi: ExtensionAPI,
  state: HandoffState
): void => {
  pi.registerTool({
    description:
      "Archive the current work and continue in a fresh branch of this session. The new branch starts from the session anchor and receives only the task and constraints you pass here. Archived work stays searchable with handoff_search.",
    // oxlint-disable-next-line require-await -- Pi requires a Promise, and recording the intent is synchronous.
    execute: async (toolCallId, params, _signal, _onUpdate, ctx) =>
      recordToolHandoff(pi, state, ctx.sessionManager, toolCallId, params),
    label: "Handoff",
    name: "handoff",
    parameters: Type.Object({
      constraints: Type.Array(Type.String()),
      task: Type.String({ minLength: 1 }),
    }),
    promptGuidelines: [
      "Use the handoff tool when the context is getting long or the work reaches a natural break. Pass the remaining task and every constraint the user gave, quoted exactly.",
    ],
    promptSnippet:
      "Archive current work and continue from the session anchor with a task and constraints",
  });

  pi.registerCommand("handoff", {
    description:
      "Archive the current work and continue from the session anchor. Usage: /handoff <task>, /handoff resume <handoffId>, or /handoff cancel <handoffId>",
    handler: async (args, ctx) => {
      const action = STALE_ACTION.exec(args.trim())?.groups;

      if (action?.verb === "resume" && action.handoffId) {
        await resumeHandoff(pi, state, action.handoffId, ctx);

        return;
      }

      if (action?.verb === "cancel" && action.handoffId) {
        await cancelHandoff(pi, state, action.handoffId, ctx);

        return;
      }

      const { task, constraints } = parseHandoffArgs(args);

      if (task.length === 0) {
        ctx.ui.notify(
          'Usage: /handoff <task>, with optional constraint lines that start with "- ".',
          "error"
        );

        return;
      }

      await ctx.waitForIdle();

      const active = activeHandoffId(state);

      if (active !== undefined) {
        ctx.ui.notify(
          `pi-handoff: handoff ${active} is already in progress.`,
          "error"
        );

        return;
      }

      const result = writeIntent(pi, ctx.sessionManager, task, constraints);

      if (!result.ok) {
        ctx.ui.notify(`pi-handoff: ${result.reason}`, "error");

        return;
      }

      await runHandoff(pi, state, result.handoffId, ctx);
    },
  });

  pi.registerCommand(RUN_COMMAND, {
    description: "Internal: continue a recorded handoff. Pi runs this itself.",
    handler: async (args, ctx) => {
      await runHandoff(pi, state, args.trim(), ctx);
    },
  });

  // Text typed while the leaf sits on the anchor would land directly under it, so hold it and
  // replay it after the continuation (queued_input).
  pi.on("input", (event, ctx) => {
    if (state.running === undefined) {
      return { action: "continue" };
    }

    const images = event.images ?? [];
    state.running.heldInput.push(
      images.length > 0
        ? [{ text: event.text, type: "text" }, ...images]
        : event.text
    );
    ctx.ui.notify(
      "pi-handoff: holding your message until the handoff finishes.",
      "info"
    );

    return { action: "handled" };
  });

  pi.on("session_before_tree", async (_event, ctx) => {
    if (state.running !== undefined) {
      await pauseIfRequested("during-navigate", ctx);
    }
  });

  pi.on("agent_settled", (event) => {
    const handoffId = state.pendingHandoffId;

    if (handoffId === undefined) {
      return;
    }

    state.pendingHandoffId = undefined;

    if (event.aborted) {
      appendCancel(pi, handoffId, "aborted-run");

      return;
    }

    pi.sendUserMessage(`/${RUN_COMMAND} ${handoffId}`, {
      expandPromptTemplates: true,
    });
  });
};
