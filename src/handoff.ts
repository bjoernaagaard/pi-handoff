import { randomUUID } from "node:crypto";

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { CUSTOM_TYPES, collectHandoffs, findAnchor } from "./records.ts";
import type {
  CancelReason,
  CancelRecord,
  IntentRecord,
  ToolCallNote,
} from "./records.ts";

export const RUN_COMMAND = "pi-handoff:run";

type SessionView = ExtensionContext["sessionManager"];

const CONSTRAINT_PREFIX = "- ";

type IntentResult =
  | { ok: true; handoffId: string }
  | { ok: false; reason: string };

/** In-memory handoff state. Only the session file is durable; this resets on restart. */
export interface HandoffState {
  /** Set by the handoff tool, consumed by agent_settled. */
  pendingHandoffId: string | undefined;
}

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

const runHandoff = async (
  handoffId: string,
  ctx: ExtensionCommandContext
): Promise<void> => {
  await ctx.waitForIdle();
  ctx.ui.notify(`pi-handoff: running handoff ${handoffId}`, "info");
};

const resumeHandoff = async (
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

  await runHandoff(handoffId, ctx);
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
  if (state.pendingHandoffId !== undefined) {
    return textResult(
      `A handoff (${state.pendingHandoffId}) is already pending.`,
      { isError: true }
    );
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
      "Archive the current work and continue from the session anchor. Usage: /handoff <task>, or /handoff resume <handoffId>",
    handler: async (args, ctx) => {
      const resume = /^resume\s+(?<handoffId>\S+)\s*$/u.exec(args.trim());

      const resumeId = resume?.groups?.handoffId;

      if (resumeId !== undefined) {
        await resumeHandoff(resumeId, ctx);

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

      if (state.pendingHandoffId !== undefined) {
        ctx.ui.notify(
          `pi-handoff: handoff ${state.pendingHandoffId} is already pending.`,
          "error"
        );

        return;
      }

      const result = writeIntent(pi, ctx.sessionManager, task, constraints);

      if (!result.ok) {
        ctx.ui.notify(`pi-handoff: ${result.reason}`, "error");

        return;
      }

      await runHandoff(result.handoffId, ctx);
    },
  });

  pi.registerCommand(RUN_COMMAND, {
    description: "Internal: continue a recorded handoff. Pi runs this itself.",
    handler: async (args, ctx) => {
      await runHandoff(args.trim(), ctx);
    },
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
