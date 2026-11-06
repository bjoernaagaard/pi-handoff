# pi-handoff implementation handoff

Status: design only. No extension code exists yet, and nothing below has been run. Every Pi behavior listed here comes from reading the installed Pi 1.5.0 source. The proposed behavior is what this extension would add.

## Goal

Keep related work in one Pi session file. Each model request should contain only a small fixed prefix and the current branch. Earlier work should stay searchable without moving back onto its branch.

```text
session file
root ... anchor (custom entry, near the start)
         ├── archived work A
         ├── archived work B
         └── active continuation C   <- current leaf
```

A handoff moves the leaf from the end of the current work back to the anchor. It then writes a destination record and a continuation message under the anchor and starts the next turn.

## Source paths

```text
PI   = ~/.local/share/mise/installs/npm-earendil-works-pi-coding-agent/1.5.0/node_modules/.mise/@earendil-works+pi-coding-agent@1.5.0_@aws-sdk+credential-provider-node@3.972.92_@smithy+signature-v4@5.7.5_ws@8.22.1/node_modules/@earendil-works/pi-coding-agent
CORE = ~/.local/share/mise/installs/npm-earendil-works-pi-coding-agent/1.5.0/node_modules/.mise/@earendil-works+pi-agent-core@1.5.0_@aws-sdk+credential-provider-node@3.972.92_@smithy+_3e4ed0485c6b1b0eb1b540cbede744a7/node_modules/@earendil-works/pi-agent-core
```

Line numbers refer to `PI/dist/...` and `CORE/dist/...` in version 1.5.0. Check them again after any Pi upgrade.

## Native Pi behavior this design relies on

| # | Behavior | Source |
| --- | --- | --- |
| N1 | `agent_settled` fires after retries, compaction and queued continuations finish. `isStreaming` is already false at that point. | `core/agent-session.js:696-718`, `1081-1083` |
| N2 | `prompt()` and `sendCustomMessage(triggerTurn)` called during `agent_settled` are deferred until every settled handler returns. | `core/agent-session.js:1650-1651`, `1883-1888`, `708-716` |
| N3 | `pi.sendUserMessage("/cmd", { expandPromptTemplates: true })` runs a registered command with an `ExtensionCommandContext`. Pi's docs show this exact pattern for running a command from `agent_settled`. | `core/agent-session.js:1654-1660`, `1716-1726`; `docs/extensions.md:1536-1561` |
| N4 | `ctx.navigateTree` exists only on the command context. | `core/extensions/types.d.ts:305-341`; `core/extensions/runner.js:724-760` |
| N5 | `navigateTree` throws while a run or a compaction is active. It returns without doing anything when the target is already the leaf. | `core/agent-session.js:3280-3290` |
| N6 | When the target is a `custom` entry, the leaf becomes that entry. When the target is a user message or a `custom_message`, the leaf becomes its parent. | `core/agent-session.js:3385-3396` |
| N7 | With `summarize: false` and no `label`, navigation writes nothing to the file. Only `leafId` changes in memory. | `core/agent-session.js:3401-3420`; `core/session-manager.js:1173-1178` |
| N8 | After navigation, Pi rebuilds the model messages, restores tools from the transcript and emits `session_tree` with `oldLeafId` and `newLeafId`. The extension instance stays the same. | `core/agent-session.js:3422-3431` |
| N9 | `session_before_tree` can cancel navigation and receives `preparation.oldLeafId`. | `core/agent-session.js:3301-3329`; `core/extensions/types.d.ts:662-690` |
| N10 | On load, the leaf is the last entry in the file. | `core/session-manager.js:733-742` |
| N11 | Every appended entry takes the current leaf as its parent and becomes the new leaf. | `core/session-manager.js:816-830`, `913-923` |
| N12 | Plain `custom` entries never reach the model. `custom_message` entries do. | `core/session-manager.js:162-191` |
| N13 | `pi.appendEntry` writes at once, even during a run. Custom messages sent during a run wait until the turn ends. | `core/agent-session.js:2801-2807`, `1890-1896` |
| N14 | A `triggerTurn` custom message is written at `message_end` before the first provider request. The compaction check and `before_agent_start` run first. | `core/agent-session.js:1497-1504`, `770-775`; `CORE/dist/agent-loop.js:55-61` |
| N15 | Pi compares the system prompt with the system messages on the current branch. When they differ, the next run records a new system message. An anchor placed before any system message therefore still gets a full system prompt. | `core/agent-session.js:1341-1346`, `1543-1546` |
| N16 | Extensions can read `getEntries`, `getEntry`, `getBranch(fromId)`, `getTree`, `getLeafId` and `getHeader`. They cannot call `getChildren`. | `core/session-manager.d.ts:178` |
| N17 | `getEntries()` returns every branch. It includes entries that compaction hides from the model. `getBranch(fromId)` follows raw parent links. | `core/session-manager.js:1074-1084`, `1119-1121` |
| N18 | `getTree()` orders siblings only by timestamp. | `core/session-manager.js:1159` |
| N19 | Compaction keeps a summary plus a recent tail of the active path. The summary covers everything before the tail, including the prefix before the anchor. | `core/session-manager.js:201-229`; `core/compaction/compaction.js:609-636` |
| N20 | `compaction.enabled: false` turns off threshold and overflow compaction. It is on by default. | `core/agent-session.js:2409-2412`; `docs/settings.md:73-75` |
| N21 | `session_before_compact` can cancel a compaction. | `docs/extensions.md:532-546` |
| N22 | In the TUI, text typed during navigation (`isCompacting` is true then) is queued. It is sent right after navigation returns, before the command handler continues. | `core/agent-session.js:1242-1246`; `modes/interactive/interactive-mode.js:2758-2766`, `1593-1609`, `3996-4046` |
| N23 | The session file is written with `appendFileSync` and no fsync. | `core/session-manager.js:801`, `813` |
| N24 | Nothing is written to a new session file until it holds a user or assistant message. Then the whole buffer is written at once. | `core/session-manager.js:792-815` |
| N25 | Tree navigation changes only session state. It does not undo file edits or outside actions. | `core/agent-session.js:3279-3433` (no file or process work) |

## What this design does not promise

- The handoff is not atomic. It is made of several separate file appends (N7, N11, N23).
- Pi cannot detect a duplicate handoff. The extension's reconciler does that (see Recovery).
- Effects do not happen exactly once. Tool effects from archived work stay in place (N25).
- Recall is not complete. Retrieval returns bounded excerpts from a text search.
- Data may be lost on power failure because Pi does not fsync (N23).

## Data shapes

Each record is a plain `custom` entry written with `pi.appendEntry`, so none of them reach the model (N12). The only record the model sees is the continuation, a `custom_message`.

```ts
type HandoffId = string & { readonly __brand: "HandoffId" };
type EntryId = string & { readonly __brand: "EntryId" };

interface AnchorRecord {
  // customType "pi-handoff/anchor"
  version: 1;
  createdAt: string;
}

interface IntentRecord {
  // customType "pi-handoff/intent", written on the source branch
  version: 1;
  handoffId: HandoffId;
  anchorId: EntryId;
  sourceSessionFile: string;
  sourceSessionId: string;
  task: string; // current task, in the user's words
  constraints: string[]; // exact active constraints, quoted, not summarized
  openToolCalls: ToolCallNote[]; // see "Uncertain tool effects"
}

interface DestinationRecord {
  // customType "pi-handoff/destination", parentId = anchorId
  version: 1;
  handoffId: HandoffId;
  intentEntryId: EntryId;
  sourceLeafId: EntryId; // finalized leaf of the work being archived
  previousDestinationId: EntryId | null; // explicit order of continuations
  sourceSessionFile: string;
  sourceSessionId: string;
}

interface ContinuationMessage {
  // custom_message, customType "pi-handoff/continuation"
  content: string; // task + constraints + source references, rendered for the model
  details: { handoffId: HandoffId; destinationId: EntryId };
}

interface CancelRecord {
  // customType "pi-handoff/cancelled", on the source branch
  version: 1;
  handoffId: HandoffId;
  reason: "aborted-run" | "tree-cancelled" | "navigate-threw" | "user";
}

interface ToolCallNote {
  toolCallId: string;
  toolName: string;
  status: "completed" | "error" | "no-result";
}
```

`sourceLeafId` and `previousDestinationId` record order explicitly. Sibling `parentId` links only show that work hangs off the anchor (N18).

## Lifecycle

```text
                 handoff tool or /handoff
idle ───────────────────────────────────────▶ intent-written (IntentRecord on source branch)
intent-written ── agent_settled(aborted=false) ─▶ dispatch "/pi-handoff:run <handoffId>"
intent-written ── agent_settled(aborted=true) ──▶ cancelled (CancelRecord)
command:
  waitForIdle()
  navigateTree(anchorId, { summarize: false })     # memory only (N7)
     ├─ cancelled / throws ─▶ CancelRecord, leaf unchanged
     └─ ok ─▶ appendEntry(DestinationRecord)       # first durable write under anchor
              sendMessage(Continuation, { triggerTurn: true })   # persisted before request (N14)
              ─▶ continuing ─▶ idle
```

1. Tools in the current run finish first. The model calls a `handoff` tool, or the user runs `/handoff`. The tool writes an `IntentRecord` with `pi.appendEntry` and returns a result with `terminate: true`. Docs show that tool shape at `docs/extensions.md:1540-1553`.
2. An `agent_settled` handler sees the pending intent. When `aborted` is true it writes a `CancelRecord` and stops. Otherwise it calls `pi.sendUserMessage("/pi-handoff:run <handoffId>", { expandPromptTemplates: true })` (N2, N3).
3. The command handler calls `ctx.waitForIdle()`. It then reads `getLeafId()` as `sourceLeafId` and calls `ctx.navigateTree(anchorId, { summarize: false })` with no label (N5 to N7).
4. When the result is cancelled or the call throws, the handler writes a `CancelRecord` on the source branch and stops. Because the leaf did not move, that record lands on the source branch.
5. The handler checks that `getLeafId() === anchorId`. When queued input has already been appended under the anchor (N22), it stops, writes nothing more and reports the problem. See "Queued input".
6. It writes the `DestinationRecord` with `pi.appendEntry`. This is the first durable write under the anchor.
7. It calls `pi.sendMessage(continuation, { triggerTurn: true })`. Pi writes the continuation before the first provider request (N14).
8. A `session_tree` and `session_start` handler rebuilds any branch-dependent extension state from `getBranch()` (N8). Pi's docs describe this rule at `docs/extensions.md:2133-2160`.

## Anchor placement

The anchor must sit near the start of the session. Everything before it is resent with every request (N19). On `session_start` with `reason: "startup" | "new"`, the extension appends an `AnchorRecord` when the branch has none. Pi buffers it until the first user message and then writes it with that message (N24). The anchor can come before any system message, because Pi records a full system message on the first run after navigation (N15).

Rule: only one anchor per session. Find it with `getEntries().find(e => e.type === "custom" && e.customType === "pi-handoff/anchor")`.

## Recovery

The reconciler runs on `session_start` for every reason. It reads all records by `handoffId` from `getEntries()`, works out the state, and does only the missing step. It never relies on the leaf's position alone.

| State found in the file | Leaf after restart (N10) | Action |
| --- | --- | --- |
| Intent only, no destination or cancel record | Source tip, because bare navigation wrote nothing (N7) | Mark the intent stale. Do not continue it automatically. Tell the user, and let the user run `/handoff resume <id>`. |
| Intent plus destination, no continuation with a matching `details.handoffId` | The destination record | Send the continuation once (step 7). |
| Destination plus continuation | The continuation or later work | Nothing to do. |
| Cancel record | The source branch | Nothing to do. |
| Entries other than the destination under the anchor before it | Somewhere under the anchor | Report the problem and do not repair it automatically. Retrieval still marks it as orphaned. |

Running the reconciler twice finds nothing left to do, so a duplicate destination or continuation is never created.

## Cancellation, queued input and uncertain tool effects

- **Cancellation.** Another extension may cancel `session_before_tree` (N9). A busy session makes `navigateTree` throw (N5). Both leave the leaf in place. The handler writes a `CancelRecord`.
- **Queued input.** Text typed during navigation can land under the anchor before the destination record (N22). An `input` handler returns `{ action: "handled" }` while a handoff is running, keeps the text, and replays it with `pi.sendUserMessage(text, { deliverAs: "followUp" })` after step 7. Check with D5 that the handler sees this input in 1.5.0.
- **Uncertain tool effects.** When `agent_settled.aborted` is true, the handoff does not start. The intent lists every tool call on the source branch since the last user message with its status. A call with no result is marked `no-result`. The continuation tells the model to check those effects before it repeats any of them. Navigation does not undo files or outside actions (N25).

## Compaction policy

Compaction conflicts with a fixed prefix. It would summarize the prefix together with the archived work and replace it (N19). Retrieval-only design:

- Handle `session_before_compact` and return `{ cancel: true }` when `reason` is `"threshold"`. Then write an intent that suggests a handoff.
- For `reason: "overflow"`, allow compaction. Cancelling it would leave the turn unable to continue. Record a `pi-handoff/compaction-allowed` entry so retrieval can show which raw entries the summary hides.
- Keep raw history searchable, because `getEntries()` still returns compacted entries (N17).

Open decision: whether users should set `compaction.enabled: false` instead (N20). That setting also turns off overflow recovery.

## Retrieval

A `handoff_search` tool lets the model read archived work without leaving the current branch.

```text
search(query, limit = 8, maxChars = 1200):
  destinations = all DestinationRecord entries, ordered by previousDestinationId links
  current      = set(getBranch(leafId))
  for entry in getEntries():                         # all branches, raw (N17)
    text = text of user, assistant, toolResult and custom_message entries
    if not matches(text, query): continue
    owner  = the first destination whose getBranch(sourceLeafId) contains entry
    status = "current"    if entry in current
             "archived"   if entry in getBranch(owner.sourceLeafId)
             "abandoned"  otherwise (an alternative left off the finalized path)
    hidden = entry is current and comes before the latest compaction's firstKeptEntryId
  return the top `limit` hits, each cut to maxChars, with
         { sessionFile, sessionId, entryId, timestamp, status, hidden, handoffId }
```

`abandoned` separates rejected alternatives from decisions on a finalized path. Results always carry the session file, session ID and entry ID, so the model can cite them.

Open decision: plain substring and regex matching, or a ranking library. Check `package.json` and the Pi bundle for an existing search dependency before adding one.

## Proposed package layout

```text
pi-handoff/
├── package.json        # "pi.extensions": ["./src/extension.ts"], host packages as "*" peers
├── src/
│   ├── extension.ts    # registers events, the command, and the two tools
│   ├── records.ts      # typed records and parsing of custom entries at the boundary
│   ├── reconcile.ts    # state of each handoffId from getEntries()
│   ├── handoff.ts      # command handler, steps 3 to 8
│   └── search.ts       # handoff_search
└── HANDOFF.md
```

Host packages (`@earendil-works/pi-coding-agent`, `typebox`) stay in `peerDependencies` with `"*"`, as `docs/packages.md` requires.

## Acceptance demonstrations

Run these against the real `pi` binary in a scratch directory, with `-e ./src/extension.ts`. Each one leaves its JSONL file and capture as an artifact. Capture provider requests with a `before_provider_request` handler that writes each payload to a file.

| ID | Steps | Pass condition |
| --- | --- | --- |
| D1 | Start a handoff. Kill pi after `navigateTree` returns, before the destination record (use a debug env var that makes the command wait). Restart. | The JSONL line count did not change. The leaf after restart is the source tip. The reconciler reports a stale intent and sends nothing. |
| D2 | Kill pi after the destination record, before the continuation. Restart twice. | The last line before restart is the destination with `parentId` equal to the anchor. The first restart sends exactly one continuation. The second restart sends none. |
| D3 | Complete a handoff and send one message. | The captured request has the system prompt, the prefix up to the anchor, the continuation and the new message. It contains no text from earlier work. |
| D4 | Have earlier work write a file with a tool, then hand off. | The file still exists with the same content. |
| D5 | Type a message while a handoff runs. | The message appears after the continuation in the JSONL, as a follow-up. |
| D6 | Set a low `compaction.reserveTokens` and fill the context. | A threshold compaction is cancelled and a handoff intent is written. No compaction entry appears. |
| D7 | Search for text from archived work A and an abandoned alternative. | The hits carry the right `status` and the source file, session ID and entry ID. |

## Open decisions for the implementer

1. What triggers a handoff: a model tool, a user command, or both.
2. Whether to cancel threshold compaction or tell users to turn compaction off.
3. Which search method to use.
4. What the continuation template says. The user should approve this text, because the model reads it every time.

## Project setup already done

- `git init` on branch `main`.
- Ultracite 8.1.1 with Oxlint, the `anti-slop` plugin and type-aware linting (`oxlint.config.ts`), and Oxfmt.
- Lefthook pre-commit hook running `bunx ultracite fix` on staged files (`lefthook.yml`).
- `AGENTS.md` and `.vscode/settings.json` from Ultracite.
- Run `bun run check` before each commit. Lefthook runs `fix` on its own.
