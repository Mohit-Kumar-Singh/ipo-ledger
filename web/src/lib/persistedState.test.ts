import { afterEach, describe, expect, it } from 'vitest'
import { loadPersistedState, savePersistedState } from './persistedState'

// vitest.config.ts runs this suite in a plain Node environment (no DOM) —
// a minimal in-memory Storage-shaped mock stands in for the browser's real
// localStorage, which is all these functions actually touch.
function makeMockStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    },
    ...overrides,
  } as Storage
}

describe('loadPersistedState / savePersistedState', () => {
  const originalLocalStorage = globalThis.localStorage

  afterEach(() => {
    globalThis.localStorage = originalLocalStorage
  })

  it('round-trips a saved value', () => {
    globalThis.localStorage = makeMockStorage()
    savePersistedState('k', ['a', 'b', 'c'])
    expect(loadPersistedState<string[]>('k', [])).toEqual(['a', 'b', 'c'])
  })

  it('returns the fallback when nothing has been saved yet', () => {
    globalThis.localStorage = makeMockStorage()
    expect(loadPersistedState('never-saved', { open: false })).toEqual({ open: false })
  })

  it('returns the fallback (never throws) when localStorage.getItem throws — private browsing', () => {
    globalThis.localStorage = makeMockStorage({
      getItem: () => {
        throw new Error('storage disabled')
      },
    })
    expect(loadPersistedState('k', 'fallback')).toBe('fallback')
  })

  it('silently no-ops (never throws) when localStorage.setItem throws — quota exceeded', () => {
    globalThis.localStorage = makeMockStorage({
      setItem: () => {
        throw new Error('quota exceeded')
      },
    })
    expect(() => savePersistedState('k', { big: 'data' })).not.toThrow()
  })
})
