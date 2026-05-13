import * as vscode from 'vscode'

/** Scans `@path/to/file` refs outside code fences and returns each match with its range. */
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
      const start = m.index + (m[0].length - m[1].length - 1)
      refs.push({ ref: m[1], range: new vscode.Range(i, start, i, start + m[1].length + 1) })
    }
  }
  return refs
}

/** Scans `/skill-name` tokens outside code fences and returns each match with its range. */
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
      out.push({ name: m[1], range: new vscode.Range(i, start, i, start + m[1].length + 1) })
    }
  }
  return out
}
