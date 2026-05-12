# Claude Prompt — VS Code Extension

A VS Code extension that turns `.prompt.md` files into a first-class Claude Code authoring experience — with slash command autocomplete, `@` file picker, hover docs, prompt linting, token count, and a one-click run button.

---

## Features

### `/` Slash Command Autocomplete

Type `/` to get a dropdown of all skills registered in your workspace (`.claude/skills/`) and `settings.json`. Each item shows the skill description and trigger conditions. Selecting a skill with **Tab** expands it into a template with tab stops you can jump between.

![Slash command autocomplete](https://raw.githubusercontent.com/henriqwe/vscode-claude-prompt/main/docs/autocomplete.png)

### `@` File Picker

Type `@` to browse workspace files and folders. Selecting a folder inserts `folder/` and immediately re-triggers the picker so you can keep drilling down. Selecting a file inserts the relative path.

```
@src/                     → lists src/ contents
@src/components/          → lists components/ contents
@src/components/Button.tsx → inserts the path
```

### Hover Documentation

Hover over any `/skill-name` to see a card with its full description, trigger conditions, and source path.

### Prompt Linting

Diagnostics appear in the editor and the **Problems** panel (`Ctrl+Shift+M`):

| Severity | Rule            | Trigger                                                           |
| -------- | --------------- | ----------------------------------------------------------------- |
| Warning  | `no-context`    | Prompt < 20 words with no file path, `@` reference, or code block |
| Warning  | `vague-scope`   | Contains "everything", "all files", or "entire codebase"          |
| Warning  | `multi-skill`   | More than one `/skill` on the same line                           |
| Error    | `unknown-skill` | `/foo` where `foo` is not registered                              |
| Info     | `long-prompt`   | Estimated token count > 2000                                      |

### Token Count + Run Button (CodeLens)

At the top of every `.prompt.md` file two CodeLens items appear:

- **▶ Run in Claude** — opens the VS Code integrated terminal and runs `claude < your-file.prompt.md`, sending the full prompt to the Claude CLI
- **⚡ ~N tokens** — estimated token count; click to open an Output panel breakdown by section

A **▶ play icon** also appears in the editor title bar for quick access.

---

## Requirements

- VS Code `^1.117.0`
- [Claude Code CLI](https://docs.anthropic.com/claude-code) installed and available in your `PATH` (required for the run button)

---

## Installation

### From VSIX

```bash
code --install-extension vscode-claude-prompt-0.1.0.vsix
```

### From source (development)

```bash
git clone https://github.com/henriqwe/vscode-claude-prompt
cd vscode-claude-prompt
npm install
npm run compile
# symlink into VS Code extensions for instant updates
ln -s $(pwd) ~/.vscode/extensions/vscode-claude-prompt
```

---

## Usage

1. Create a file ending in `.prompt.md` anywhere in your workspace, e.g. `my-task.prompt.md`
2. Open it in VS Code — the extension activates automatically
3. Write your prompt using `/skills` and `@files` as references
4. Click **▶ Run in Claude** (CodeLens or title bar) to execute

### Example prompt file

```markdown
# Refactor auth service

Context: @src/services/auth.ts

The current implementation stores session tokens in localStorage.
Migrate to httpOnly cookies following the pattern in @src/services/api.ts.

/refactor-plan
```

---

## Skill Discovery

The extension reads skills from two sources and merges them:

1. **`.claude/skills/` directories** — each subfolder becomes a skill; its name is the folder name and its description is read from `README.md`
2. **`.claude/settings.json`** — any names listed in a top-level `skills` array are added

Skills hot-reload automatically when these files change — no restart needed.

---

## Development

```bash
npm run compile      # one-shot build
npm run watch        # incremental watch build
npm test             # run unit tests (Vitest)
npm run test:watch   # watch mode
vsce package --no-dependencies  # build .vsix
vsce package --no-dependencies && code --install-extension vscode-claude-prompt-0.1.0.vsix
```

---

## License

MIT
