import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { SkillRegistry } from './skillRegistry'
import { countTokens } from './tokenizer'

const SOURCE = 'claude-prompt'

function isLintEnabled(rule: string): boolean {
  const config = vscode.workspace.getConfiguration('claude-prompt')
  return config.get<boolean>(`lint.${rule}`, true)
}

export class LintProvider implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection
  private disposables: vscode.Disposable[] = []

  constructor(private readonly registry: SkillRegistry) {
    this.collection = vscode.languages.createDiagnosticCollection(SOURCE)

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (isPromptFile(e.document)) this.lint(e.document)
      }),
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (isPromptFile(doc)) this.lint(doc)
      }),
      vscode.workspace.onDidCloseTextDocument(doc => {
        this.collection.delete(doc.uri)
      }),
      registry.onDidChange(() => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (isPromptFile(editor.document)) this.lint(editor.document)
        }
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('claude-prompt.lint')) return
        for (const editor of vscode.window.visibleTextEditors) {
          if (isPromptFile(editor.document)) this.lint(editor.document)
        }
      }),
    )
  }

  lint(document: vscode.TextDocument): void {
    const text = document.getText()
    const diagnostics: vscode.Diagnostic[] = []

    diagnostics.push(...checkNoContext(document, text))
    diagnostics.push(...checkVagueScope(document, text))
    diagnostics.push(...checkMultiSkill(document, text))
    diagnostics.push(...checkUnknownSkill(document, text, this.registry))
    diagnostics.push(...checkLongPrompt(document, text))

    const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
    if (workspaceRoot) {
      if (isLintEnabled('unresolved-file-ref')) {
        diagnostics.push(...checkUnresolvedFileRef(document, workspaceRoot))
      }
      if (isLintEnabled('outside-workspace')) {
        diagnostics.push(...checkOutsideWorkspace(document, workspaceRoot))
      }
    }
    if (isLintEnabled('duplicate-skill')) {
      diagnostics.push(...checkDuplicateSkill(document))
    }
    if (isLintEnabled('missing-tabstops')) {
      diagnostics.push(...checkMissingTabstops(document, text))
    }

    this.collection.set(document.uri, diagnostics)
  }

  dispose(): void {
    this.collection.dispose()
    this.disposables.forEach(d => d.dispose())
  }
}

function isPromptFile(doc: vscode.TextDocument): boolean {
  return doc.fileName.endsWith('.prompt.md')
}

function makeRange(document: vscode.TextDocument, lineIndex: number): vscode.Range {
  const line = document.lineAt(lineIndex)
  return line.range
}

function checkNoContext(doc: vscode.TextDocument, text: string): vscode.Diagnostic[] {
  const wordCount = text.trim().split(/\s+/).length
  const hasFilePath = /[^\s]+\.[a-z]{1,5}(\/|$)/i.test(text)
  const hasAtReference = /@[^\s]/.test(text)
  const hasCodeBlock = /```/.test(text)

  if (wordCount < 20 && !hasFilePath && !hasAtReference && !hasCodeBlock) {
    const diag = new vscode.Diagnostic(
      makeRange(doc, 0),
      'No context provided — include a file path, function name, or code block.',
      vscode.DiagnosticSeverity.Warning,
    )
    diag.source = SOURCE
    diag.code = 'no-context'
    return [diag]
  }
  return []
}

function checkVagueScope(doc: vscode.TextDocument, text: string): vscode.Diagnostic[] {
  const vaguePattern = /\b(everything|all files|entire codebase)\b/gi
  const diagnostics: vscode.Diagnostic[] = []
  let match: RegExpExecArray | null

  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text
    vaguePattern.lastIndex = 0
    while ((match = vaguePattern.exec(line)) !== null) {
      const range = new vscode.Range(i, match.index, i, match.index + match[0].length)
      const diag = new vscode.Diagnostic(
        range,
        `Vague scope: "${match[0]}" may produce unpredictable results.`,
        vscode.DiagnosticSeverity.Warning,
      )
      diag.source = SOURCE
      diag.code = 'vague-scope'
      diagnostics.push(diag)
    }
  }
  return diagnostics
}

function checkMultiSkill(doc: vscode.TextDocument, _text: string): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = []
  // only match /skill when preceded by start-of-line or whitespace (not inside a path like @src/foo)
  const skillPattern = /(^|\s)\/[a-z][a-z0-9-]*/g

  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text
    const matches = Array.from(line.matchAll(skillPattern))
    if (matches.length > 1) {
      const diag = new vscode.Diagnostic(
        makeRange(doc, i),
        'Multiple slash commands on one line — consider splitting into separate prompts.',
        vscode.DiagnosticSeverity.Warning,
      )
      diag.source = SOURCE
      diag.code = 'multi-skill'
      diagnostics.push(diag)
    }
  }
  return diagnostics
}

function checkUnknownSkill(
  doc: vscode.TextDocument,
  _text: string,
  registry: SkillRegistry,
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = []
  // only match /skill when preceded by start-of-line or whitespace (not inside a path like @src/foo)
  const skillPattern = /(?:^|\s)(\/([a-z][a-z0-9-]*))/g

  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text
    let match: RegExpExecArray | null
    skillPattern.lastIndex = 0
    while ((match = skillPattern.exec(line)) !== null) {
      const slashToken = match[1] // e.g. "/create-service"
      const name = match[2]       // e.g. "create-service"
      const tokenStart = match.index + (match[0].length - slashToken.length)
      if (!registry.has(name)) {
        const range = new vscode.Range(i, tokenStart, i, tokenStart + slashToken.length)
        const diag = new vscode.Diagnostic(
          range,
          `Unknown skill: "${slashToken}" is not registered in .claude/skills/ or settings.json.`,
          vscode.DiagnosticSeverity.Error,
        )
        diag.source = SOURCE
        diag.code = 'unknown-skill'
        diagnostics.push(diag)
      }
    }
  }
  return diagnostics
}

function checkLongPrompt(doc: vscode.TextDocument, text: string): vscode.Diagnostic[] {
  const tokens = countTokens(text)
  if (tokens > 2000) {
    const diag = new vscode.Diagnostic(
      makeRange(doc, 0),
      `Long prompt: ~${tokens} estimated tokens (> 2000). Consider breaking it up.`,
      vscode.DiagnosticSeverity.Information,
    )
    diag.source = SOURCE
    diag.code = 'long-prompt'
    return [diag]
  }
  return []
}

/** Scans @path/to/file refs outside code fences and returns each match with its range. */
export function findFileRefs(doc: vscode.TextDocument): Array<{ ref: string; range: vscode.Range }> {
  const refs: Array<{ ref: string; range: vscode.Range }> = []
  let inFence = false
  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text
    if (/^```/.test(line.trim())) { inFence = !inFence; continue }
    if (inFence) continue
    const pattern = /(?:^|[\s(\[])@([./\w-]+\.[A-Za-z0-9]+)\b/g
    let m: RegExpExecArray | null
    while ((m = pattern.exec(line)) !== null) {
      const start = m.index + (m[0].length - m[1].length - 1) // pos of '@'
      const range = new vscode.Range(i, start, i, start + m[1].length + 1)
      refs.push({ ref: m[1], range })
    }
  }
  return refs
}

function checkUnresolvedFileRef(doc: vscode.TextDocument, workspaceRoot: string): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = []
  for (const { ref, range } of findFileRefs(doc)) {
    const abs = path.resolve(workspaceRoot, ref)
    if (!fs.existsSync(abs)) {
      const diag = new vscode.Diagnostic(
        range,
        `Unresolved reference: "@${ref}" does not exist.`,
        vscode.DiagnosticSeverity.Error,
      )
      diag.source = SOURCE
      diag.code = 'unresolved-file-ref'
      out.push(diag)
    }
  }
  return out
}

function checkOutsideWorkspace(doc: vscode.TextDocument, workspaceRoot: string): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = []
  const rootResolved = path.resolve(workspaceRoot) + path.sep
  for (const { ref, range } of findFileRefs(doc)) {
    const abs = path.resolve(workspaceRoot, ref)
    if (!abs.startsWith(rootResolved) && abs !== path.resolve(workspaceRoot)) {
      const diag = new vscode.Diagnostic(
        range,
        `Reference resolves outside the workspace: "@${ref}".`,
        vscode.DiagnosticSeverity.Warning,
      )
      diag.source = SOURCE
      diag.code = 'outside-workspace'
      out.push(diag)
    }
  }
  return out
}

export function findSkillInvocations(doc: vscode.TextDocument): Array<{ name: string; range: vscode.Range }> {
  const out: Array<{ name: string; range: vscode.Range }> = []
  let inFence = false
  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text
    if (/^```/.test(line.trim())) { inFence = !inFence; continue }
    if (inFence) continue
    const pattern = /(?:^|\s)\/([a-z][a-z0-9-]*)\b/g
    let m: RegExpExecArray | null
    while ((m = pattern.exec(line)) !== null) {
      const start = m.index + (m[0].length - m[1].length - 1)
      const range = new vscode.Range(i, start, i, start + m[1].length + 1)
      out.push({ name: m[1], range })
    }
  }
  return out
}

function checkDuplicateSkill(doc: vscode.TextDocument): vscode.Diagnostic[] {
  const seen = new Map<string, vscode.Range>()
  const out: vscode.Diagnostic[] = []
  for (const { name, range } of findSkillInvocations(doc)) {
    if (seen.has(name)) {
      const diag = new vscode.Diagnostic(
        range,
        `Duplicate skill invocation: "/${name}" appears more than once.`,
        vscode.DiagnosticSeverity.Information,
      )
      diag.source = SOURCE
      diag.code = 'duplicate-skill'
      out.push(diag)
    } else {
      seen.set(name, range)
    }
  }
  return out
}

function checkMissingTabstops(doc: vscode.TextDocument, text: string): vscode.Diagnostic[] {
  // Snippet placeholders typically look like ${1:label} or $1 — if they appear
  // literally in the saved document, the user expanded a skill but never filled it in.
  const out: vscode.Diagnostic[] = []
  const pattern = /\$\{?\d+(:[^}]*)?\}?/g
  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text
    let m: RegExpExecArray | null
    pattern.lastIndex = 0
    while ((m = pattern.exec(line)) !== null) {
      const range = new vscode.Range(i, m.index, i, m.index + m[0].length)
      const diag = new vscode.Diagnostic(
        range,
        `Unfilled snippet placeholder: "${m[0]}".`,
        vscode.DiagnosticSeverity.Warning,
      )
      diag.source = SOURCE
      diag.code = 'missing-tabstops'
      out.push(diag)
    }
  }
  return out
}
