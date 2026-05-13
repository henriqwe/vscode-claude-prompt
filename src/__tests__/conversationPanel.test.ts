import { describe, it, expect } from 'vitest'
import { RunRecord, TurnRecord } from '../runHistory'

// Pure logic extracted from ConversationPanel for testing without a VS Code host.

function buildTurnArgs(
  baseArgs: string[],
  turnIndex: number,
  sessionId: string | null,
): string[] {
  const args = ['-p', '--verbose', '--output-format', 'stream-json']
  if (turnIndex > 0 && sessionId) {
    args.push('--resume', sessionId)
  } else {
    args.push(...baseArgs)
  }
  return args
}

function isSessionError(turnIndex: number, exitCode: number | null): boolean {
  return turnIndex > 0 && exitCode !== 0 && exitCode !== null
}

function buildRecord(
  runId: string,
  filePath: string,
  model: string,
  startedAt: number,
  sessionId: string | null,
  turns: TurnRecord[],
  lastExitCode: number | null,
): RunRecord {
  return {
    id: runId,
    filePath,
    fileLabel: filePath.split('/').pop() ?? filePath,
    timestamp: startedAt,
    durationMs: Date.now() - startedAt,
    exitCode: lastExitCode,
    model,
    tokensIn: turns.reduce((s, t) => s + t.tokensIn, 0),
    tokensOut: turns.reduce((s, t) => s + t.tokensOut, 0),
    output: turns.map(t => t.output).join('\n\n---\n\n'),
    sessionId,
    turns,
  }
}

describe('ConversationPanel arg building', () => {
  const baseArgs = ['--model', 'claude-opus-4-7']

  it('first turn omits --resume and includes base args', () => {
    const args = buildTurnArgs(baseArgs, 0, null)
    expect(args).toContain('--model')
    expect(args).toContain('claude-opus-4-7')
    expect(args).not.toContain('--resume')
  })

  it('follow-up with sessionId includes --resume', () => {
    const args = buildTurnArgs(baseArgs, 1, 'sess-abc')
    expect(args).toContain('--resume')
    expect(args).toContain('sess-abc')
    expect(args).not.toContain('--model')
  })

  it('follow-up without sessionId omits --resume', () => {
    const args = buildTurnArgs(baseArgs, 1, null)
    expect(args).not.toContain('--resume')
  })
})

describe('ConversationPanel session error detection', () => {
  it('first turn exit 1 is NOT a session error', () => {
    expect(isSessionError(0, 1)).toBe(false)
  })

  it('follow-up turn exit 1 IS a session error', () => {
    expect(isSessionError(1, 1)).toBe(true)
  })

  it('follow-up turn exit 0 is not an error', () => {
    expect(isSessionError(1, 0)).toBe(false)
  })

  it('follow-up turn exit null (cancelled) is not a session error', () => {
    expect(isSessionError(1, null)).toBe(false)
  })
})

describe('RunRecord with turns', () => {
  const turn1: TurnRecord = { userMessage: 'refactor auth', output: 'Done', tokensIn: 10, tokensOut: 5, durationMs: 1000, exitCode: 0 }
  const turn2: TurnRecord = { userMessage: 'now do tests', output: 'Tests updated', tokensIn: 8, tokensOut: 12, durationMs: 800, exitCode: 0 }

  it('aggregates tokensIn and tokensOut across turns', () => {
    const rec = buildRecord('id1', '/a/b.prompt.md', 'claude-opus-4-7', Date.now() - 2000, 'sess1', [turn1, turn2], 0)
    expect(rec.tokensIn).toBe(18)
    expect(rec.tokensOut).toBe(17)
  })

  it('concatenates output with separator', () => {
    const rec = buildRecord('id1', '/a/b.prompt.md', 'claude-opus-4-7', Date.now() - 2000, 'sess1', [turn1, turn2], 0)
    expect(rec.output).toContain('Done')
    expect(rec.output).toContain('Tests updated')
    expect(rec.output).toContain('---')
  })

  it('stores sessionId', () => {
    const rec = buildRecord('id1', '/a/b.prompt.md', 'claude-opus-4-7', Date.now() - 2000, 'sess-xyz', [turn1], 0)
    expect(rec.sessionId).toBe('sess-xyz')
  })

  it('old record without turns field replays gracefully', () => {
    const old: RunRecord = { id: 'old', filePath: '/x.prompt.md', fileLabel: 'x.prompt.md', timestamp: 0, durationMs: 500, exitCode: 0, model: 'claude-opus-4-7', tokensIn: 5, tokensOut: 3, output: 'Hello' }
    // Replay code uses: record.turns?.length ? record.turns : [fallback]
    const replayTurns: TurnRecord[] = old.turns?.length
      ? old.turns
      : [{ userMessage: '', output: old.output, tokensIn: old.tokensIn, tokensOut: old.tokensOut, durationMs: old.durationMs, exitCode: old.exitCode }]
    expect(replayTurns).toHaveLength(1)
    expect(replayTurns[0].output).toBe('Hello')
  })
})
