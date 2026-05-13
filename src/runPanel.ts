import * as vscode from 'vscode'
import { RunHistory, RunRecord } from './runHistory'
import { ConversationPanel, ConversationPanelInput } from './conversationPanel'

// Kept for callers in runner.ts — same shape as ConversationPanelInput
export type RunPanelInput = ConversationPanelInput

/**
 * Thin adapter that forwards to `ConversationPanel`.
 * Exists so `runner.ts` doesn't need to import `conversationPanel.ts` directly,
 * keeping the run-dispatch logic decoupled from the webview implementation.
 */
export class RunPanel {
  constructor(history: RunHistory, input: RunPanelInput) {
    new ConversationPanel(history, input)
  }

  static replay(history: RunHistory, record: RunRecord): vscode.WebviewPanel {
    return ConversationPanel.replay(history, record)
  }
}
