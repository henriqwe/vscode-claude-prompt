import { describe, it, expect } from 'vitest'
import { buildArgs } from '../runner'

describe('buildArgs', () => {
  it('empty when no options', () => {
    expect(buildArgs({})).toEqual([])
  })

  it('model flag', () => {
    expect(buildArgs({ model: 'claude-opus-4-7' })).toEqual(['--model', 'claude-opus-4-7'])
  })

  it('thinking flag', () => {
    expect(buildArgs({ thinking: true })).toEqual(['--thinking'])
  })

  it('splits extra flags on whitespace', () => {
    expect(buildArgs({ extraFlags: '--verbose --foo bar' })).toEqual(['--verbose', '--foo', 'bar'])
  })

  it('combines everything', () => {
    expect(buildArgs({ model: 'claude-sonnet-4-6', thinking: true, extraFlags: '-v' }))
      .toEqual(['--model', 'claude-sonnet-4-6', '--thinking', '-v'])
  })
})
