import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  arr,
  compile,
  lit,
  nullable,
  obj,
  oneOf,
  str,
} from "@earendil-works/pi-schema";
import type { Static, Validator } from "@earendil-works/pi-schema";

export const CUSTOM_TYPES = {
  anchor: "pi-handoff/anchor",
  cancelled: "pi-handoff/cancelled",
  compactionAllowed: "pi-handoff/compaction-allowed",
  continuation: "pi-handoff/continuation",
  destination: "pi-handoff/destination",
  intent: "pi-handoff/intent",
} as const;

const Id = str({ minLength: 1 });

const AnchorSchema = obj({
  createdAt: str({ format: "date-time" }),
  version: lit(1),
});

const ToolCallNoteSchema = obj({
  status: oneOf(["completed", "error", "no-result"]),
  toolCallId: Id,
  toolName: Id,
});

const IntentSchema = obj({
  anchorId: Id,
  constraints: arr(str()),
  handoffId: Id,
  openToolCalls: arr(ToolCallNoteSchema),
  sourceSessionFile: Id,
  sourceSessionId: Id,
  task: Id,
  version: lit(1),
});

// The destination entry's parentId must equal the intent's anchorId.
const DestinationSchema = obj({
  handoffId: Id,
  intentEntryId: Id,
  previousDestinationId: nullable(Id),
  sourceLeafId: Id,
  sourceSessionFile: Id,
  sourceSessionId: Id,
  version: lit(1),
});

const ContinuationDetailsSchema = obj({ destinationId: Id, handoffId: Id });

const CancelSchema = obj({
  handoffId: Id,
  reason: oneOf([
    "aborted-run",
    "tree-cancelled",
    "navigate-threw",
    "leaf-moved",
    "user",
  ]),
  version: lit(1),
});

const CompactionAllowedSchema = obj({
  reason: oneOf(["overflow", "manual"]),
  version: lit(1),
});

export type AnchorRecord = Static<typeof AnchorSchema>;

export type ToolCallNote = Static<typeof ToolCallNoteSchema>;

export type IntentRecord = Static<typeof IntentSchema>;

export type DestinationRecord = Static<typeof DestinationSchema>;

export type ContinuationDetails = Static<typeof ContinuationDetailsSchema>;

export type CancelRecord = Static<typeof CancelSchema>;

export type CancelReason = CancelRecord["reason"];

export type CompactionAllowedRecord = Static<typeof CompactionAllowedSchema>;

export const anchorRecord = compile(AnchorSchema);

export const intentRecord = compile(IntentSchema);

export const destinationRecord = compile(DestinationSchema);

export const continuationDetails = compile(ContinuationDetailsSchema);

export const cancelRecord = compile(CancelSchema);

export const compactionAllowedRecord = compile(CompactionAllowedSchema);

type CustomType = (typeof CUSTOM_TYPES)[keyof typeof CUSTOM_TYPES];

/**
 * The record an entry of `customType` carries, from `data` on a custom entry or `details`
 * on a custom_message. Session files are parsed without validation (F29), so a record that
 * fails its check is logged and treated as missing.
 */
export const readRecord = <T>(
  entry: SessionEntry,
  customType: CustomType,
  validator: Validator<T>
): T | undefined => {
  let payload: unknown;

  if (entry.type === "custom" && entry.customType === customType) {
    payload = entry.data;
  } else if (
    entry.type === "custom_message" &&
    entry.customType === customType
  ) {
    payload = entry.details;
  } else {
    return undefined;
  }

  if (validator.check(payload)) {
    return payload;
  }

  console.error(
    `pi-handoff: ignoring invalid ${customType} entry ${entry.id}`,
    JSON.stringify(validator.errors(payload))
  );

  return undefined;
};
