import * as fs from 'fs'
import * as path from 'path'
import { countTokens } from './tokenizer'
import type { SkillRegistry, Skill } from './skillRegistry'

export type SectionKind = 'text' | 'file' | 'skill' | 'include'

export interface SourceRange {
  startLine: number
  startCol: number
  endLine: number
  endCol: number
}

export interface ExpandedSection {
  kind: SectionKind
  range: SourceRange
  source: string
  content: string
  tokens: number
}

export interface UnresolvedRef {
  kind: 'file' | 'skill' | 'include'
  ref: string
  range: SourceRange
  reason: string
}

export interface ExpansionResult {
  expanded: string
  sections: ExpandedSection[]
  unresolved: UnresolvedRef[]
  variables: Record<string, string>
}

export interface ExpansionOptions {
  workspaceRoot: string
  registry: Pick<SkillRegistry, 'get' | 'has'>
  vars?: Record<string, string>
  maxDepth?: number
  /** Override filesystem reads — used by tests. */
  readFile?: (absPath: string) => string | null
}

const DEFAULT_MAX_DEPTH = 5

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.json': 'json',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.java': 'java',
  '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
  '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml',
  '.sh': 'bash', '.fish': 'fish', '.zsh': 'zsh', '.sql': 'sql', '.css': 'css',
  '.html': 'html', '.xml': 'xml',
}

function defaultRead(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Parses YAML frontmatter (only scalar string/number/boolean) at the top of the document.
 * Returns the parsed vars and the text with frontmatter stripped.
 */
export function parseFrontmatter(text: string): {
  vars: Record<string, string>
  body: string
  consumedLines: number
} {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return { vars: {}, body: text, consumedLines: 0 }

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break }
  }
  if (end === -1) return { vars: {}, body: text, consumedLines: 0 }

  const vars: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    // strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    vars[key] = value
  }
  return { vars, body: lines.slice(end + 1).join('\n'), consumedLines: end + 1 }
}

export async function expand(text: string, options: ExpansionOptions): Promise<ExpansionResult> {
  const read = options.readFile ?? defaultRead
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH

  const { vars: fmVars, body, consumedLines } = parseFrontmatter(text)
  const variables = { ...fmVars, ...(options.vars ?? {}) }

  const sections: ExpandedSection[] = []
  const unresolved: UnresolvedRef[] = []

  const expanded = expandRecursive(body, {
    depth: 0,
    maxDepth,
    workspaceRoot: options.workspaceRoot,
    registry: options.registry,
    variables,
    visited: new Set<string>(),
    lineOffset: consumedLines,
    sections,
    unresolved,
    read,
  })

  return { expanded, sections, unresolved, variables }
}

interface RecursiveCtx {
  depth: number
  maxDepth: number
  workspaceRoot: string
  registry: Pick<SkillRegistry, 'get' | 'has'>
  variables: Record<string, string>
  visited: Set<string>
  lineOffset: number
  sections: ExpandedSection[]
  unresolved: UnresolvedRef[]
  read: (absPath: string) => string | null
}

function expandRecursive(text: string, ctx: RecursiveCtx): string {
  if (ctx.depth > ctx.maxDepth) return text

  // 1) {{var}} substitution (single pass, no recursion into substituted values)
  let result = text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g, (m, name) => {
    if (Object.prototype.hasOwnProperty.call(ctx.variables, name)) {
      return ctx.variables[name]
    }
    ctx.unresolved.push({
      kind: 'include',
      ref: name,
      range: zeroRange(ctx.lineOffset),
      reason: `Unresolved variable {{${name}}}`,
    })
    return m
  })

  // 2) !include directives, line-by-line
  const lines = result.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^```/.test(line.trim())) inFence = !inFence
    const includeMatch = !inFence ? /^!include\s+(\S.*)$/.exec(line) : null
    if (includeMatch) {
      const relPath = includeMatch[1].trim()
      const absPath = path.resolve(ctx.workspaceRoot, relPath)
      const range = lineRange(ctx.lineOffset + i, line.length)
      if (ctx.visited.has(absPath)) {
        ctx.unresolved.push({ kind: 'include', ref: relPath, range, reason: 'Cyclic include' })
        out.push(line)
        continue
      }
      const content = ctx.read(absPath)
      if (content == null) {
        ctx.unresolved.push({ kind: 'include', ref: relPath, range, reason: 'File not found' })
        out.push(line)
        continue
      }
      const childVisited = new Set(ctx.visited)
      childVisited.add(absPath)
      const expanded = expandRecursive(content, {
        ...ctx,
        depth: ctx.depth + 1,
        visited: childVisited,
        lineOffset: 0,
      })
      ctx.sections.push({
        kind: 'include',
        range,
        source: relPath,
        content: expanded,
        tokens: countTokens(expanded),
      })
      out.push(expanded)
    } else {
      out.push(line)
    }
  }
  result = out.join('\n')

  // 3) @file references — inline files as fenced blocks
  // Match @path/to/file outside of code fences.
  result = replaceOutsideFences(result, /(^|[\s(\[])@([./\w-]+\.[A-Za-z0-9]+)\b/g, (match, prefix, refPath, lineIdx, colIdx) => {
    const relPath = refPath.replace(/^\/+/, '')
    const absPath = path.resolve(ctx.workspaceRoot, relPath)
    const range = lineRange(ctx.lineOffset + lineIdx, refPath.length, colIdx + prefix.length)
    const content = ctx.read(absPath)
    if (content == null) {
      ctx.unresolved.push({ kind: 'file', ref: refPath, range, reason: 'File not found' })
      return match
    }
    const ext = path.extname(refPath).toLowerCase()
    const lang = LANG_BY_EXT[ext] ?? ''
    const fenced = `${prefix}\n\`\`\`${lang} ${refPath}\n${content}\n\`\`\`\n`
    ctx.sections.push({
      kind: 'file',
      range,
      source: refPath,
      content,
      tokens: countTokens(content),
    })
    return fenced
  })

  // 4) /skill references — inline skill READMEs
  result = replaceOutsideFences(result, /(^|\s)\/([a-z][a-z0-9-]*)\b/g, (match, prefix, name, lineIdx, colIdx) => {
    const skill = ctx.registry.get(name)
    const range = lineRange(ctx.lineOffset + lineIdx, name.length + 1, colIdx + prefix.length)
    if (!skill) {
      ctx.unresolved.push({ kind: 'skill', ref: name, range, reason: 'Unknown skill' })
      return match
    }
    const body = readSkillBody(skill, ctx.read)
    if (body == null) {
      ctx.unresolved.push({ kind: 'skill', ref: name, range, reason: 'Skill has no README' })
      return match
    }
    ctx.sections.push({
      kind: 'skill',
      range,
      source: name,
      content: body,
      tokens: countTokens(body),
    })
    return `${prefix}\n<!-- skill: ${name} -->\n${body}\n`
  })

  return result
}

function readSkillBody(skill: Skill, read: (p: string) => string | null): string | null {
  if (!skill.readmePath) return null
  const raw = read(skill.readmePath)
  if (raw == null) return null
  // Strip frontmatter if present
  const { body } = parseFrontmatter(raw)
  return body.trim()
}

/**
 * Run a replacement only on text segments outside fenced code blocks.
 * Callback receives (match, ...groups, lineIdx, colIdx).
 */
function replaceOutsideFences(
  text: string,
  pattern: RegExp,
  replacer: (match: string, ...args: any[]) => string,
): string {
  const lines = text.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i].trim())) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const original = lines[i]
    const re = new RegExp(pattern.source, pattern.flags)
    lines[i] = original.replace(re, (match, ...args) => {
      // args: [groups..., offset, fullString, ...maybeNamed]
      // Find offset (last number) — replace stops at named groups, so scan.
      let offset = 0
      for (let k = args.length - 1; k >= 0; k--) {
        if (typeof args[k] === 'number') { offset = args[k]; break }
      }
      const groups = args.filter(a => typeof a !== 'number' && typeof a !== 'object')
      return replacer(match, ...groups, i, offset)
    })
  }
  return lines.join('\n')
}

function zeroRange(line: number): SourceRange {
  return { startLine: line, startCol: 0, endLine: line, endCol: 0 }
}

function lineRange(line: number, length: number, col = 0): SourceRange {
  return { startLine: line, startCol: col, endLine: line, endCol: col + length }
}
