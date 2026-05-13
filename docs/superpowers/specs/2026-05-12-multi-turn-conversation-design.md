# Multi-turn Conversation Design

**Date:** 2026-05-12
**Status:** Approved

## Problem

The current `RunPanel` is one-shot: you send a prompt, Claude responds, done. For chained tasks — "refactor auth → now do the tests → now update the docs" — users must open a new `.prompt.md` file and lose all context. The goal is to let users send follow-up messages in the same panel, continuing the same Claude session.

## Scope

- Reply bar appears below the output when a run finishes
- Follow-ups use `claude -p --resume <session_id>` to continue the session
- Each turn's output is appended to the panel with a visual separator
- Run history stores all turns per conversation for replay
- Session expiry is handled gracefully with an inline error

Out of scope: per-turn replay seeking, branch/alternate-reply UI, exporting individual turns.

## Architecture

### Components

**`ConversationPanel`** (new — `src/conversationPanel.ts`)

Owns the webview panel and the full turn loop.

- Constructor takes `RunHistory` and `ConversationPanelInput` (same shape as current `RunPanelInput`)
- Calls `startTurn(message, sessionId?)` internally for the first turn
- `startTurn` spawns `claude -p --verbose --output-format stream-json [--resume session_id]`, pipes `message` to stdin
- On `system` init event: captures `session_id`, stores on instance
- Streams text/thinking/tool events into the webview exactly as `RunPanel` does today
- On `finish()`: saves the turn to the local `turns` array, posts `turn-done` event to webview; webview renders the reply bar
- On webview `reply` message: calls `startTurn(text, this.sessionId)`
- On webview `cancel` message: kills the active child process

**`RunPanel`** (shrinks — `src/runPanel.ts`)

Becomes a thin factory. Creates a `ConversationPanel` and delegates immediately.

```typescript
export class RunPanel {
  constructor(history: RunHistory, input: RunPanelInput) {
    new ConversationPanel(history, input)
  }
  static replay(history: RunHistory, record: RunRecord) {
    return ConversationPanel.replay(history, record)
  }
}
```

All callers in `extension.ts` and `runner.ts` stay unchanged — they still `new RunPanel(...)`.

**`runner.ts`** — no changes needed.

### Data Flow

```
runner.ts
  → expand prompt
  → new RunPanel(history, input)         // delegates to ConversationPanel
      → startTurn(expandedText)
          → spawn: claude -p --verbose --output-format stream-json
          → system event → store session_id
          → stream text/tool/thinking events → webview
          → finish() → save TurnRecord → post turn-done

User types in reply bar
  → webview posts { kind: 'reply', text: '...' }
  → ConversationPanel.startTurn(text, session_id)
      → spawn: claude -p --resume <session_id> --verbose --output-format stream-json
      → stream next turn → webview (appended with separator)
      → finish() → save TurnRecord → post turn-done
```

## RunHistory Schema

`RunRecord` is extended; existing fields are preserved so old history entries still display in the sidebar.

```typescript
interface TurnRecord {
  userMessage: string   // expanded prompt text (turn 1) or raw follow-up text
  output: string        // Claude's full markdown response for this turn
  tokensIn: number
  tokensOut: number
  durationMs: number
  exitCode: number | null
}

interface RunRecord {
  // existing fields — unchanged
  id: string
  filePath: string
  fileLabel: string
  timestamp: number
  model: string
  exitCode: number | null
  durationMs: number    // total across all turns
  tokensIn: number      // aggregate across all turns
  tokensOut: number     // aggregate across all turns
  output: string        // aggregate: all turns concatenated (for sidebar preview)

  // new fields
  sessionId: string | null   // from stream-json system.session_id
  turns: TurnRecord[]        // one entry per turn; turn 1 always present
}
```

Old `RunRecord` entries without `turns` are treated as single-turn conversations on replay (backwards compatible).

## Webview Events

### Extension → Webview (new)

| Event | Payload | Meaning |
|---|---|---|
| `turn-done` | `{ exitCode, durationMs, stats?, isError }` | Current turn finished |
| `turn-start` | `{ turnIndex: number }` | New turn beginning (shows separator) |

Existing events (`text`, `thinking`, `tool-start`, `tool-result`, `system`, `log`) are unchanged and reused per-turn. The `done` event from `RunPanel` is **not** used in `ConversationPanel` — `turn-done` replaces it.

### Webview → Extension (new)

| Event | Payload | Meaning |
|---|---|---|
| `reply` | `{ text: string }` | User submitted a follow-up message |

Existing `cancel` event already handled.

## Webview UI Changes

After a turn completes (`turn-done`), the webview renders a reply bar at the bottom:

```
┌─────────────────────────────────────────────────────┐
│ Continue this session                               │
│ ┌──────────────────────────────────┐ [Send]        │
│ │ Follow up or ask a question…    │               │
│ └──────────────────────────────────┘               │
└─────────────────────────────────────────────────────┘
```

When the user submits a follow-up, the reply bar is hidden and a turn separator is inserted above the new streaming output:

```
─── Turn 2 ──────────────────────────────────────────
You: Now update the tests in auth.test.ts to match.

[streaming Claude response...]
```

When `turn-done` fires again the reply bar reappears.

## Error Handling

**Session expired:** If `--resume` fails (exit code ≠ 0 on turn 2+), `finish()` detects this and posts a `turn-done` with `isError: true`. The webview shows an inline message in the reply bar area:

> Session expired — [Start new run] to continue.

"Start new run" fires `claude-prompt.run` on the same file.

**Normal cancellation:** Killing the child on cancel mid-turn still works; `turn-done` fires with the partial output and a non-zero exit code.

## Testing

Unit tests (Vitest, no extension host) cover:

- `ConversationPanel` can be instantiated with a mock webview and mock child process
- `startTurn` with no `sessionId` builds args without `--resume`
- `startTurn` with a `sessionId` includes `--resume <id>`
- `turn-done` with `exitCode !== 0` on turn ≥ 2 sets `isError: true`
- `RunHistory.add` with multi-turn `RunRecord` round-trips through JSON correctly
- Old single-turn `RunRecord` (no `turns` field) replays without error

Integration: manual test in the extension host by running a `.prompt.md`, verifying reply bar appears, sending a follow-up, and confirming `--resume` is passed.
