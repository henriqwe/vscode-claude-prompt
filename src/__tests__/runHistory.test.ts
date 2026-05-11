import { describe, it, expect } from 'vitest'
import { bucketOf } from '../runHistory'

describe('bucketOf', () => {
  const now = new Date('2026-05-11T12:00:00Z').getTime()
  const dayMs = 24 * 60 * 60 * 1000

  it('Today for a timestamp within today', () => {
    expect(bucketOf(now - 1000, now)).toBe('Today')
  })

  it('Yesterday for ~1 day ago', () => {
    expect(bucketOf(now - dayMs - 1000, now)).toBe('Yesterday')
  })

  it('This week for ~3 days ago', () => {
    expect(bucketOf(now - 3 * dayMs, now)).toBe('This week')
  })

  it('Older for more than a week', () => {
    expect(bucketOf(now - 10 * dayMs, now)).toBe('Older')
  })
})
