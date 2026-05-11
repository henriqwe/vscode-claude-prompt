import * as vscode from 'vscode'
import * as fs from 'fs'

/** Extract the first H1 heading from markdown text, falling back to null. */
export function extractFirstHeading(text: string): string | null {
  const lines = text.split('\n')
  let inFence = false
  let inFrontmatter = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i === 0 && line.trim() === '---') { inFrontmatter = true; continue }
    if (inFrontmatter) {
      if (line.trim() === '---') inFrontmatter = false
      continue
    }
    if (/^```/.test(line.trim())) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^#\s+(.+)$/.exec(line)
    if (m) return m[1].trim()
  }
  return null
}

export async function openPromptCommand(): Promise<void> {
  const files = await vscode.workspace.findFiles('**/*.prompt.md', '**/node_modules/**', 500)
  if (files.length === 0) {
    vscode.window.showInformationMessage('No .prompt.md files found in this workspace.')
    return
  }

  const items = await Promise.all(files.map(async uri => {
    let heading: string | null = null
    let mtimeMs = 0
    try {
      const buf = fs.readFileSync(uri.fsPath, { encoding: 'utf8' }).slice(0, 2048)
      heading = extractFirstHeading(buf)
      mtimeMs = fs.statSync(uri.fsPath).mtimeMs
    } catch {
      // ignore
    }
    const relative = vscode.workspace.asRelativePath(uri)
    return {
      label: heading ?? relative,
      description: heading ? relative : undefined,
      detail: `modified ${relativeTime(mtimeMs)}`,
      uri,
      mtimeMs,
    }
  }))

  items.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Open prompt',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  if (!picked) return
  await vscode.window.showTextDocument(picked.uri)
}

function relativeTime(ms: number): string {
  if (!ms) return 'unknown'
  const diff = Date.now() - ms
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return 'just now'
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  return `${Math.floor(diff / day)}d ago`
}
