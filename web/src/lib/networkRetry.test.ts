import { describe, expect, it, vi } from 'vitest'
import { withRetry, isTransientNetworkError } from './networkRetry'

describe('isTransientNetworkError', () => {
  it('flags a bare TypeError (Safari "Load failed")', () => {
    expect(isTransientNetworkError(new TypeError('Load failed'))).toBe(true)
  })
  it('flags a supabase-style error object with no code and a transport message', () => {
    expect(isTransientNetworkError({ message: 'TypeError: Load failed' })).toBe(true)
    expect(isTransientNetworkError({ message: 'Failed to fetch' })).toBe(true)
    expect(isTransientNetworkError({ message: 'The network connection was lost.' })).toBe(true)
  })
  it('does NOT flag a real Postgres/PostgREST error (has a code)', () => {
    expect(isTransientNetworkError({ code: '23505', message: 'duplicate key value' })).toBe(false)
    expect(isTransientNetworkError({ code: '42501', message: 'new row violates row-level security' })).toBe(false)
    expect(isTransientNetworkError({ code: 'PGRST116', message: 'Load failed' })).toBe(false)
  })
  it('does NOT flag an ordinary application error', () => {
    expect(isTransientNetworkError({ message: 'lot_size must be positive' })).toBe(false)
    expect(isTransientNetworkError(new Error('boom'))).toBe(false)
  })
})

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue({ data: { id: 'x' }, error: null })
    const r = await withRetry(fn, { retries: 3, baseDelayMs: 1 })
    expect(r).toEqual({ data: { id: 'x' }, error: null })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a transient supabase { error } result, then succeeds', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Load failed' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'Load failed' } })
      .mockResolvedValue({ data: { id: 'ok' }, error: null })
    const r = await withRetry(fn, { retries: 3, baseDelayMs: 1 })
    expect(r).toEqual({ data: { id: 'ok' }, error: null })
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry a real DB error — returns it on the first call', async () => {
    const fn = vi.fn().mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate' } })
    const r = await withRetry(fn, { retries: 3, baseDelayMs: 1 })
    expect((r as { error: { code: string } }).error.code).toBe('23505')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a thrown TypeError, then rethrows if it never clears', async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError('Load failed'))
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow('Load failed')
    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('returns the last transient result once retries are exhausted (no throw)', async () => {
    const fn = vi.fn().mockResolvedValue({ data: null, error: { message: 'Load failed' } })
    const r = await withRetry(fn, { retries: 2, baseDelayMs: 1 })
    expect((r as { error: { message: string } }).error.message).toBe('Load failed')
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
