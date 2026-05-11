// Minimal vscode API mock for unit tests (no extension host needed)
import { EventEmitter as NodeEventEmitter } from 'events'

class VscodeEventEmitter<T> {
  private emitter = new NodeEventEmitter()
  event = (listener: (e: T) => void) => {
    this.emitter.on('event', listener)
    return { dispose: () => this.emitter.off('event', listener) }
  }
  fire(data: T) { this.emitter.emit('event', data) }
  dispose() { this.emitter.removeAllListeners() }
}

export const EventEmitter = VscodeEventEmitter

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 }

export class Range {
  constructor(
    public start: { line: number; character: number } | number,
    public end: { line: number; character: number } | number,
    public endChar?: number,
    public endChar2?: number,
  ) {}
}

export class Diagnostic {
  source?: string
  code?: string
  constructor(
    public range: Range,
    public message: string,
    public severity: number,
  ) {}
}

export class MarkdownString {
  value = ''
  isTrusted = false
  supportHtml = false
  constructor(_v = '', _trusted = false) {}
  appendMarkdown(v: string) { this.value += v; return this }
}

export class SnippetString {
  constructor(public value: string) {}
}

export class CompletionItem {
  detail?: string
  documentation?: MarkdownString
  filterText?: string
  sortText?: string
  insertText?: string | SnippetString
  range?: Range
  constructor(public label: string, public kind: number) {}
}

export const CompletionItemKind = { Function: 2 }

export class Hover {
  constructor(public contents: MarkdownString, public range?: Range) {}
}

export const languages = {
  createDiagnosticCollection: (_name: string) => ({
    set: () => {},
    delete: () => {},
    dispose: () => {},
  }),
}

export const workspace = {
  workspaceFolders: [] as { uri: { fsPath: string } }[],
  createFileSystemWatcher: (_pattern: string) => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    onDidChange: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  onDidChangeTextDocument: () => ({ dispose: () => {} }),
  onDidOpenTextDocument: () => ({ dispose: () => {} }),
  onDidCloseTextDocument: () => ({ dispose: () => {} }),
  textDocuments: [] as unknown[],
}

export const window = {
  activeTextEditor: undefined as unknown,
  onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
  visibleTextEditors: [] as unknown[],
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: '',
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  createOutputChannel: (_name: string) => ({
    clear: () => {},
    appendLine: (_s: string) => {},
    show: () => {},
    dispose: () => {},
  }),
}

export const commands = {
  registerCommand: (_id: string, _handler: () => void) => ({ dispose: () => {} }),
}

export const StatusBarAlignment = { Left: 1, Right: 2 }
