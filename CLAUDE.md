# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile          # one-shot TypeScript build → out/
npm run watch            # incremental watch build
npm test                 # run unit tests (Vitest, no extension host)
npm run test:watch       # Vitest in watch mode
vsce package --no-dependencies  # build .vsix package
```

Run a single test file:
```bash
npx vitest run src/__tests__/lintRules.test.ts
```

## Architecture

This is a VS Code extension that activates on `*.prompt.md` files (language ID `claude-prompt`). All providers are registered in `extension.ts:activate()` and share a single `SkillRegistry` instance.

### Key modules

- **`skillRegistry.ts`** — Reads skills from both project-local `.claude/skills/` and the global `~/.claude/skills/` directories, plus their respective `settings.json` files. Skills carry a `source: 'project' | 'global'` field; project skills take precedence on name collisions. Hot-reloads via `FileSystemWatcher` on all four sources. Exposes `extractDescription`, `extractTriggerConditions`, and `extractSnippetTabStops` as pure functions (used in tests and providers).

- **`completionProvider.ts`** — Handles `/` trigger. Filters registry skills by prefix, builds `SnippetString` tab stops from the skill's README ARGUMENTS section via `extractSnippetTabStops`.

- **`fileCompletionProvider.ts`** — Handles `@` trigger. Walks the filesystem to provide file/folder path completion, re-triggering on folder selection.

- **`lintProvider.ts`** — Five lint rules (`no-context`, `vague-scope`, `multi-skill`, `unknown-skill`, `long-prompt`) applied on every document change. Re-lints open files when the skill registry changes.

- **`statusBarItem.ts`** — Token estimation (`text.length / 4`), status bar item, and the `claude-prompt.showTokenBreakdown` command output channel. `estimateTokens` is exported and reused by `codeLensProvider.ts`.

- **`codeLensProvider.ts`** — Emits two CodeLens items at line 0: **▶ Run in Claude** and **⚡ ~N tokens**.

- **`hoverProvider.ts`** — Hover card for `/skill-name` tokens showing description, trigger conditions, parsed ARGUMENTS, and source path. Results are cached per skill name and invalidated on registry change.

- **`conversationPanel.ts`** — Webview panel that drives multi-turn conversations with the Claude CLI. Streams `--output-format stream-json` output, renders text/thinking/tool events in real time, and allows the user to send follow-up messages in the same Claude session (via `--resume <sessionId>`). Supports replay of past runs via `ConversationPanel.replay()`.

- **`runHistory.ts`** — Persists up to 100 `RunRecord` entries (with per-turn `TurnRecord[]`) in VS Code `globalState`. Provides `RunHistoryTreeProvider` for the sidebar tree view, bucketing runs into Today / Yesterday / This week / Older.

- **`skillTreeProvider.ts`** — Renders registered skills in a sidebar tree grouped into **Project** and **Global** buckets. Each skill node runs `claude-prompt.insertSkill` on click.

### Testing approach

Unit tests run with Vitest in a plain Node environment — no VS Code extension host. The `vscode` module is aliased to `src/__tests__/mocks/vscode.ts`, a hand-rolled stub. Tests exercise pure functions (`extractDescription`, `extractTriggerConditions`, lint rules) and providers directly by instantiating them with mock registries.

`tsconfig.json` excludes `src/__tests__/` — the test build uses `tsconfig.test.json` implicitly via Vitest's TypeScript support.

### Skill discovery contract

A skill directory at `.claude/skills/<name>/` must contain a `README.md` (or any `.md` file). The extension parses:
- **Description**: first non-heading, non-empty line
- **Trigger conditions**: first bullet after a heading matching `when to use|triggers when|use this skill when`
- **Snippet tab stops**: bullet items under an `## ARGUMENTS` heading (or top-level bullets if absent)
