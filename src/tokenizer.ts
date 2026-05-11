import { createHash } from 'crypto'

type Encoder = (text: string) => number[] | Uint32Array

let encoderImpl: Encoder | null = null
let encoderFailed = false

function loadEncoder(): Encoder | null {
  if (encoderImpl) return encoderImpl
  if (encoderFailed) return null
  try {
    // cl100k_base is the closest publicly available BPE to modern frontier models.
    // It's not exact for Claude, but it's within ~5% for typical prose/code.
    const mod = require('gpt-tokenizer/encoding/cl100k_base') as { encode: Encoder }
    encoderImpl = mod.encode
    return encoderImpl
  } catch {
    encoderFailed = true
    return null
  }
}

const MAX_CACHE = 100
const cache = new Map<string, number>()

function cacheKey(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

export function countTokens(text: string): number {
  if (!text) return 0

  const key = cacheKey(text)
  const cached = cache.get(key)
  if (cached !== undefined) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const encode = loadEncoder()
  let tokens: number
  if (encode) {
    try {
      tokens = encode(text).length
    } catch {
      tokens = Math.ceil(text.length / 4)
    }
  } else {
    tokens = Math.ceil(text.length / 4)
  }

  cache.set(key, tokens)
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  return tokens
}

export function clearCache(): void {
  cache.clear()
}
