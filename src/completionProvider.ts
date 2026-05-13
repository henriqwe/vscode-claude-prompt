import * as vscode from 'vscode'
import { SkillRegistry } from './skillRegistry'

/**
 * Provides `/skill-name` completions when the user types `/` at the start of a
 * line or after whitespace in a `.prompt.md` file.
 * Each item shows the skill description and trigger conditions as hover docs.
 */
export class CompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly registry: SkillRegistry) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const linePrefix = document.lineAt(position).text.slice(0, position.character)
    const slashIndex = linePrefix.lastIndexOf('/')
    if (slashIndex === -1) return []

    // only trigger when the / is preceded by start-of-line, space, or newline
    const charBefore = linePrefix[slashIndex - 1]
    if (charBefore !== undefined && charBefore !== ' ' && charBefore !== '\t') return []

    const typed = linePrefix.slice(slashIndex + 1).toLowerCase()
    const skills = this.registry.getAll().filter(s => s.name.toLowerCase().startsWith(typed))

    return skills.map(skill => {
      const item = new vscode.CompletionItem(`/${skill.name}`, vscode.CompletionItemKind.Function)
      item.detail = skill.sourcePath
      item.documentation = new vscode.MarkdownString(
        [
          skill.description,
          skill.triggerConditions ? `\n\n**Triggers when:** ${skill.triggerConditions}` : '',
        ]
          .join('')
          .trim(),
      )
      item.filterText = `/${skill.name}`
      item.sortText = skill.name

      item.insertText = new vscode.SnippetString(`/${skill.name}`)

      // replace from the / character to the current position
      item.range = new vscode.Range(position.with(undefined, slashIndex), position)

      return item
    })
  }
}

