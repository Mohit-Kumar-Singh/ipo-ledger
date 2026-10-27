// PostgREST (Supabase's API) silently caps every response at 1000 rows
// (`max_rows`) — no error, no flag, the rest of the rows just aren't there.
// Any read that isn't scoped down to a naturally small set (one IPO, one
// account, a .limit()) WILL hit that cap once the table grows: the allotment
// board did at 1010 rows, and two allotted applications quietly vanished from
// it while the Applications page still listed them.
//
// This pages through with .range() until a short page comes back. The caller
// builds the query and MUST order it by something unique (or end the order
// with a unique tiebreaker such as `id`) — without a stable order, Postgres
// is free to return rows in a different order per request, and pages can
// overlap or skip rows, which is the same bug in a subtler shape.
//
//   const { data, error } = await fetchAllRows((from, to) =>
//     supabase.from('applications').select('*').order('id').range(from, to))
//
// Returns the same { data, error } shape a single supabase call does, so a
// call site only swaps how the query is issued, not how its result is read.

export const PAGE_SIZE = 1000

type PageResult<T, E> = { data: T[] | null; error: E | null }

export async function fetchAllRows<T, E = unknown>(
  page: (from: number, to: number) => PromiseLike<PageResult<T, E>>,
): Promise<{ data: T[]; error: null } | { data: null; error: E }> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    if (error) return { data: null, error }
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < PAGE_SIZE) return { data: all, error: null }
  }
}
