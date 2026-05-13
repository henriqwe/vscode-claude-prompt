export interface ParsedFrontmatter {
  body: string
  fields: Record<string, string>
  consumedLines: number
}

/**
 * Parses YAML frontmatter delimited by `---` lines at the top of a document.
 * Only scalar string values are extracted (numbers and booleans become strings).
 * Returns `{ body, fields, consumedLines }` — body has the frontmatter stripped,
 * fields holds the parsed key/value pairs, and consumedLines is the number of
 * lines occupied by the frontmatter block (including the two `---` delimiters).
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') {
    return { body: content, fields: {}, consumedLines: 0 }
  }

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break }
  }
  if (end === -1) return { body: content, fields: {}, consumedLines: 0 }

  const fields: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/.exec(lines[i])
    if (!m) continue
    fields[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }

  return {
    body: lines.slice(end + 1).join('\n'),
    fields,
    consumedLines: end + 1,
  }
}
