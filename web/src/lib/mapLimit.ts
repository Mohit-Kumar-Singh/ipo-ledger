// Runs `fn` over `items` with at most `limit` calls in flight at once and
// returns the results in the original order (like Promise.all over a map, but
// without firing every request at the same instant - an import of a few
// hundred applications used to open that many simultaneous requests).
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  await Promise.all(workers)
  return results
}
