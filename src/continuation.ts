import { CUSTOM_TYPES } from "./records.ts";
import type {
  ContinuationDetails,
  DestinationRecord,
  IntentRecord,
} from "./records.ts";

/**
 * The approved continuation text (HANDOFF.yaml contracts.continuation_template, H1).
 * Do not change the wording without asking the user.
 */
export const renderContinuation = (
  intent: IntentRecord,
  destination: DestinationRecord
): string => {
  const constraintLines =
    intent.constraints.length > 0
      ? intent.constraints.map((constraint) => `- ${constraint}`)
      : ["- None recorded."];

  const unfinished = intent.openToolCalls.filter(
    (call) => call.status !== "completed"
  );

  const unfinishedLines =
    unfinished.length > 0
      ? [
          "Tool calls from the archived work that may not have finished",
          ...unfinished.map(
            (call) => `- ${call.toolName} (${call.toolCallId}): ${call.status}`
          ),
          "Check the real state of each one before you run it again.",
        ]
      : [];

  return [
    "You are continuing work from an earlier part of this session. That earlier work is archived, not deleted. You cannot see it here, but you can search it with the handoff_search tool.",
    "",
    "Task",
    intent.task,
    "",
    "Constraints that still apply. They are quoted exactly. Follow every one.",
    ...constraintLines,
    "",
    "Where this came from",
    `- Session file: ${destination.sourceSessionFile}`,
    `- Session ID: ${destination.sourceSessionId}`,
    `- Last entry of the archived work: ${destination.sourceLeafId}`,
    `- Handoff ID: ${destination.handoffId}`,
    ...unfinishedLines,
    "",
    'Files and outside changes made by the archived work are still in place. Before you rely on an earlier decision, find it with handoff_search and cite its entry ID. Results marked "abandoned" are alternatives that were dropped, not decisions.',
  ].join("\n");
};

export const continuationMessage = (
  intent: IntentRecord,
  destination: DestinationRecord,
  destinationId: string
) => {
  const details: ContinuationDetails = {
    destinationId,
    handoffId: destination.handoffId,
  };

  return {
    content: renderContinuation(intent, destination),
    customType: CUSTOM_TYPES.continuation,
    details,
    display: true,
  };
};
