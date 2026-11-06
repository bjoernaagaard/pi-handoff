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

export interface Recorded<T> {
  entry: SessionEntry;
  record: T;
}

/** Every record written for one handoff. Pi does not detect duplicates, so the first of each kind wins. */
export interface HandoffRecords {
  handoffId: string;
  intent?: Recorded<IntentRecord>;
  destination?: Recorded<DestinationRecord>;
  continuation?: Recorded<ContinuationDetails>;
  cancel?: Recorded<CancelRecord>;
}

const slotFor = (
  handoffs: Map<string, HandoffRecords>,
  handoffId: string
): HandoffRecords => {
  const existing = handoffs.get(handoffId);

  if (existing) {
    return existing;
  }

  const created: HandoffRecords = { handoffId };
  handoffs.set(handoffId, created);

  return created;
};

const addRecord = (
  handoffs: Map<string, HandoffRecords>,
  entry: SessionEntry
): void => {
  const intent = readRecord(entry, CUSTOM_TYPES.intent, intentRecord);

  if (intent) {
    const slot = slotFor(handoffs, intent.handoffId);
    slot.intent ??= { entry, record: intent };

    return;
  }

  const destination = readRecord(
    entry,
    CUSTOM_TYPES.destination,
    destinationRecord
  );

  if (destination) {
    const slot = slotFor(handoffs, destination.handoffId);
    slot.destination ??= { entry, record: destination };

    return;
  }

  const continuation = readRecord(
    entry,
    CUSTOM_TYPES.continuation,
    continuationDetails
  );

  if (continuation) {
    const slot = slotFor(handoffs, continuation.handoffId);
    slot.continuation ??= { entry, record: continuation };

    return;
  }

  const cancel = readRecord(entry, CUSTOM_TYPES.cancelled, cancelRecord);

  if (cancel) {
    const slot = slotFor(handoffs, cancel.handoffId);
    slot.cancel ??= { entry, record: cancel };
  }
};

/**
 * Groups handoff records by handoffId, in file order. A destination counts only when it sits
 * directly under the anchor its intent names, as the destination contract requires.
 */
export const collectHandoffs = (
  entries: readonly SessionEntry[]
): Map<string, HandoffRecords> => {
  const handoffs = new Map<string, HandoffRecords>();

  for (const entry of entries) {
    addRecord(handoffs, entry);
  }

  for (const handoff of handoffs.values()) {
    const { destination, intent } = handoff;

    const misplaced =
      destination !== undefined &&
      destination.entry.parentId !== intent?.record.anchorId;

    if (misplaced) {
      console.error(
        `pi-handoff: ignoring destination ${destination.entry.id}, it is not under the anchor of handoff ${handoff.handoffId}`
      );
      handoff.destination = undefined;
    }
  }

  return handoffs;
};

/**
 * Finalized destinations, oldest first, linked by previousDestinationId (never by timestamps, F18).
 * The newest is the one no other destination names as previous.
 */
export const orderedDestinations = (
  handoffs: ReadonlyMap<string, HandoffRecords>
): Recorded<DestinationRecord>[] => {
  const destinations = [...handoffs.values()].flatMap((handoff) =>
    handoff.destination ? [handoff.destination] : []
  );

  const byId = new Map(
    destinations.map((destination) => [destination.entry.id, destination])
  );

  const referenced = new Set(
    destinations.map((destination) => destination.record.previousDestinationId)
  );

  const newest = destinations.findLast(
    (destination) => !referenced.has(destination.entry.id)
  );

  const chain: Recorded<DestinationRecord>[] = [];
  const seen = new Set<string>();
  let current = newest;

  while (current && !seen.has(current.entry.id)) {
    seen.add(current.entry.id);
    chain.unshift(current);
    const previousId = current.record.previousDestinationId;
    current = previousId === null ? undefined : byId.get(previousId);
  }

  return chain;
};

/** The session's one anchor: the first valid anchor entry in file order. */
export const findAnchor = (
  entries: readonly SessionEntry[]
): SessionEntry | undefined =>
  entries.find(
    (entry) =>
      readRecord(entry, CUSTOM_TYPES.anchor, anchorRecord) !== undefined
  );
