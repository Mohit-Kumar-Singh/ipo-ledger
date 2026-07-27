// Persists in-progress form state to localStorage so it survives Chrome
// discarding/reloading a backgrounded tab (which otherwise silently wipes
// unsaved in-memory form state). Callers load once on mount, save on every
// change, and clear on cancel/successful submit.
export function loadDraft<T>(key: string): Partial<T> | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Partial<T>) : null
  } catch {
    return null
  }
}

export function saveDraft<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage full/unavailable — draft persistence is a nicety, not critical
  }
}

export function clearDraft(key: string) {
  localStorage.removeItem(key)
}
