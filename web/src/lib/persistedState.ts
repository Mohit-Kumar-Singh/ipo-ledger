// Persists small bits of UI state (which panels are expanded, a chosen
// filter/sort) to localStorage, so navigating away from a page and back —
// which unmounts the component and resets any plain useState — doesn't
// throw away where you left off. Purely a convenience, never load-bearing:
// a failure (private browsing, storage disabled, quota) just means state
// resets to its default, exactly like it always did before this existed.
// Same defensive try/catch shape as lib/formDraft.ts's loadDraft/saveDraft
// (a related but distinct concern — that one's for in-progress form input
// surviving a discarded tab, this one's for UI state surviving navigation).
export function loadPersistedState<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function savePersistedState<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage full/unavailable/private browsing — a convenience, not critical
  }
}
