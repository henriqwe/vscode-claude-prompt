import * as vscode from 'vscode'

const IGNORED = /^(node_modules|\.git|out|dist|\.next|coverage|\.vscode)$/

/**
 * Provides `@path/to/file` completions when the user types `@` (or `/` inside a
 * folder path) in a `.prompt.md` file.
 * Directories are listed before files and inserting a directory appends `/` then
 * re-triggers completion so the user can drill down without extra keystrokes.
 */
export class FileCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const linePrefix = document.lineAt(position).text.slice(0, position.character)
    const atIndex = linePrefix.lastIndexOf('@')
    if (atIndex === -1) return []

    const charBefore = linePrefix[atIndex - 1]
    if (charBefore !== undefined && charBefore !== ' ' && charBefore !== '\t') return []

    const typed = linePrefix.slice(atIndex + 1) // preserve case for path matching

    const rootUri = vscode.workspace.getWorkspaceFolder(document.uri)?.uri
      ?? vscode.workspace.workspaceFolders?.[0]?.uri
    if (!rootUri) return []

    // split typed into directory prefix + current filter
    const lastSlash = typed.lastIndexOf('/')
    const dirPrefix = lastSlash === -1 ? '' : typed.slice(0, lastSlash + 1)
    const filter = lastSlash === -1 ? typed.toLowerCase() : typed.slice(lastSlash + 1).toLowerCase()

    const dirUri = dirPrefix
      ? vscode.Uri.joinPath(rootUri, dirPrefix)
      : rootUri

    let entries: [string, vscode.FileType][]
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri)
    } catch {
      return []
    }

    return entries
      .filter(([name, type]) => {
        if (IGNORED.test(name)) return false
        if (filter && !name.toLowerCase().startsWith(filter)) return false
        return (
          type === vscode.FileType.File ||
          type === vscode.FileType.Directory
        )
      })
      .sort(([aName, aType], [bName, bType]) => {
        // directories first
        if (aType !== bType) return aType === vscode.FileType.Directory ? -1 : 1
        return aName.localeCompare(bName)
      })
      .map(([name, type]) => {
        const isDir = type === vscode.FileType.Directory
        const fullRelPath = dirPrefix + name + (isDir ? '/' : '')

        const item = new vscode.CompletionItem(
          { label: name, description: isDir ? 'folder' : undefined },
          isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File,
        )

        item.filterText = `@${typed}${name}`
        item.sortText = (isDir ? '0' : '1') + name.toLowerCase()

        // replace from the character after @ to current position
        item.range = new vscode.Range(position.with(undefined, atIndex + 1), position)
        item.insertText = fullRelPath

        if (isDir) {
          // re-trigger completion after inserting folder/ so user can keep browsing
          item.command = {
            command: 'editor.action.triggerSuggest',
            title: 'Re-trigger completions',
          }
        }

        return item
      })
  }
}
