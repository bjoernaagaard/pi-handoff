import type {
  CustomMessageEntry,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { findOrphanRoots } from "./reconcile.ts";
import { collectHandoffs, findAnchor, orderedDestinations } from "./records.ts";

type SessionView = ExtensionContext["sessionManager"];

const SEARCH_TOOL = "handoff_search";

const DEFAULT_LIMIT = 8;

const MAX_CHARS_PER_HIT = 1200;

// Share of the excerpt shown before the match, so the reader sees what led up to it.
const LEAD_FRACTION = 0.25;

type HitStatus = "current" | "archived" | "abandoned" | "orphaned";

interface SearchHit {
  sessionFile: string;
  sessionId: string;
  entryId: string;
  timestamp: string;
  status: HitStatus;
  hiddenByCompaction: boolean;
  handoffId: string | null;
  excerpt: string;
}

type AgentMessage = SessionMessageEntry["message"];

type SearchedMessage = Extract<
  AgentMessage,
  { role: "user" | "assistant" | "toolResult" }
>;

type ContentBlock =
  | Exclude<SearchedMessage["content"], string>[number]
  | Exclude<CustomMessageEntry["content"], string>[number];

const blockText = (block: ContentBlock): string[] => {
  switch (block.type) {
    case "text": {
      return [block.text];
    }

    case "toolCall": {
      return [`${block.name}(${JSON.stringify(block.arguments)})`];
    }

    case "thinking":
    case "image": {
      return [];
    }

    // Session files are not validated (F29), so an unknown block adds no text instead of failing the search.
    default: {
      return [];
    }
  }
};

const contentText = (content: string | readonly ContentBlock[]): string =>
  Array.isArray(content) ? content.flatMap(blockText).join("\n") : content;

/** Searchable text of user, assistant, toolResult and custom_message entries. */
const searchableText = (entry: SessionEntry): string | undefined => {
  if (entry.type === "custom_message") {
    return contentText(entry.content);
  }

  if (entry.type !== "message") {
    return undefined;
  }

  const { message } = entry;

  if (message.role === "toolResult") {
    // Earlier search results would echo every query back as a hit.
    return message.toolName === SEARCH_TOOL
      ? undefined
      : contentText(message.content);
  }

  if (message.role === "user" || message.role === "assistant") {
    return contentText(message.content);
  }

  return undefined;
};

const excerptAround = (text: string, matchIndex: number): string => {
  if (text.length <= MAX_CHARS_PER_HIT) {
    return text;
  }

  const start = Math.max(
    0,
    Math.min(
      matchIndex - Math.floor(MAX_CHARS_PER_HIT * LEAD_FRACTION),
      text.length - MAX_CHARS_PER_HIT
    )
  );

  return text.slice(start, start + MAX_CHARS_PER_HIT);
};

const idsOf = (entries: readonly SessionEntry[]) =>
  new Set(entries.map((entry) => entry.id));

/** Ids of every entry hidden from the model by the latest compaction on the current branch (F19). */
const hiddenIds = (branch: readonly SessionEntry[]): Set<string> => {
  const compaction = branch.findLast((entry) => entry.type === "compaction");

  if (compaction?.type !== "compaction") {
    return new Set();
  }

  const firstKeptIndex = branch.findIndex(
    (entry) => entry.id === compaction.firstKeptEntryId
  );

  return idsOf(branch.slice(0, Math.max(firstKeptIndex, 0)));
};

/** contracts.handoff_search_tool.algorithm, over every branch of this session file (F17). */
export const searchSession = (
  sessionManager: SessionView,
  query: string,
  limit: number
): SearchHit[] => {
  const entries = sessionManager.getEntries();
  const anchor = findAnchor(entries);
  const destinations = orderedDestinations(collectHandoffs(entries));

  const finalizedPaths = destinations.map((destination) => ({
    handoffId: destination.record.handoffId,
    ids: idsOf(sessionManager.getBranch(destination.record.sourceLeafId)),
  }));

  const branch = sessionManager.getBranch();
  const current = idsOf(branch);

  const currentHandoffId =
    destinations.findLast((destination) => current.has(destination.entry.id))
      ?.record.handoffId ?? null;

  const hidden = hiddenIds(branch);
  const orphanRoots = new Set(findOrphanRoots(entries, sessionManager));
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];

  for (const entry of entries.toReversed()) {
    if (hits.length >= limit) {
      break;
    }

    const text = searchableText(entry);
    const matchIndex = text?.toLowerCase().indexOf(needle) ?? -1;

    if (text === undefined || matchIndex === -1) {
      continue;
    }

    const path = sessionManager.getBranch(entry.id);

    const anchorIndex =
      anchor === undefined
        ? -1
        : path.findIndex((step) => step.id === anchor.id);

    const isUnderAnchor = anchorIndex !== -1 && anchorIndex < path.length - 1;
    const anchorChild = path.at(anchorIndex + 1);
    const owner = finalizedPaths.find(({ ids }) => ids.has(entry.id));
    let status: HitStatus = "abandoned";

    if (current.has(entry.id)) {
      status = "current";
    } else if (owner) {
      status = "archived";
    } else if (
      isUnderAnchor &&
      anchorChild !== undefined &&
      orphanRoots.has(anchorChild.id)
    ) {
      status = "orphaned";
    }

    hits.push({
      entryId: entry.id,
      excerpt: excerptAround(text, matchIndex),
      handoffId:
        status === "current" ? currentHandoffId : (owner?.handoffId ?? null),
      hiddenByCompaction: hidden.has(entry.id),
      sessionFile: sessionManager.getSessionFile() ?? "",
      sessionId: sessionManager.getSessionId(),
      status,
      timestamp: entry.timestamp,
    });
  }

  return hits;
};

export const registerSearch = (pi: ExtensionAPI): void => {
  pi.registerTool({
    description: `Search every branch of this session file, including work archived by handoffs, for a case-insensitive substring. Returns up to 20 hits, newest first, each with sessionFile, sessionId, entryId, timestamp, status (current, archived, abandoned or orphaned), hiddenByCompaction, handoffId and an excerpt of at most ${MAX_CHARS_PER_HIT} characters.`,
    // oxlint-disable-next-line require-await -- Pi requires a Promise, and the search is synchronous.
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const hits = searchSession(
        ctx.sessionManager,
        params.query,
        params.limit ?? DEFAULT_LIMIT
      );

      return {
        content: [{ text: JSON.stringify(hits, null, 2), type: "text" }],
        details: { hits },
      };
    },
    label: "Handoff search",
    name: SEARCH_TOOL,
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ maximum: 20, minimum: 1 })),
      query: Type.String({ minLength: 1 }),
    }),
    promptGuidelines: [
      'Use handoff_search to find decisions and facts from archived work before relying on them, and cite the entryId of each hit you use. Treat hits with status "abandoned" as dropped alternatives, not decisions.',
    ],
    promptSnippet: "Search archived and current work in this session file",
  });
};
