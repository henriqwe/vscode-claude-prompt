import * as vscode from 'vscode'
import { RunHistory, RunRecord } from './runHistory'
import { ConversationPanel, ConversationPanelInput } from './conversationPanel'

// Kept for callers in runner.ts — same shape as ConversationPanelInput
export type RunPanelInput = ConversationPanelInput

export class RunPanel {
  constructor(history: RunHistory, input: RunPanelInput) {
    new ConversationPanel(history, input)
  }

  static replay(history: RunHistory, record: RunRecord): vscode.WebviewPanel {
    return ConversationPanel.replay(history, record)
  }
}
