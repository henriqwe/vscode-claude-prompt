import { describe, it, expect } from 'vitest'
import { buildCommand } from '../runner'

describe('buildCommand', () => {
  it('builds the default command', () => {
    expect(buildCommand('/tmp/p.md', {})).toBe('claude < "/tmp/p.md"')
  })

  it('adds model flag', () => {
    expect(buildCommand('/tmp/p.md', { model: 'claude-opus-4-7' }))
      .toBe('claude --model claude-opus-4-7 < "/tmp/p.md"')
  })

  it('adds thinking flag', () => {
    expect(buildCommand('/tmp/p.md', { thinking: true }))
      .toBe('claude --thinking < "/tmp/p.md"')
  })

  it('appends extra flags', () => {
    expect(buildCommand('/tmp/p.md', { extraFlags: '--verbose' }))
      .toBe('claude --verbose < "/tmp/p.md"')
  })

  it('combines all options', () => {
    const cmd = buildCommand('/tmp/p.md', {
      model: 'claude-sonnet-4-6',
      thinking: true,
      extraFlags: '--verbose',
    })
    expect(cmd).toBe('claude --model claude-sonnet-4-6 --thinking --verbose < "/tmp/p.md"')
  })

  it('ignores empty extraFlags', () => {
    expect(buildCommand('/tmp/p.md', { extraFlags: '   ' }))
      .toBe('claude < "/tmp/p.md"')
  })
})
