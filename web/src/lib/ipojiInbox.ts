import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'

export interface IpojiInboxMeta {
  id: string
  row_count: number
  created_at: string
}

// The newest scrape the phone bookmarklet sent to this admin's inbox (see
// supabase/functions/ipoji-inbox). Metadata only — the rows themselves can
// be hundreds of KB, so they're fetched once, on Review. Polled while the
// app is open and refreshed when it comes back to the foreground, which is
// how a phone user sees the result the moment they switch back from ipoji.
export function useIpojiInbox(enabled: boolean) {
  return useQuery({
    queryKey: ['ipoji_inbox'],
    enabled,
    refetchInterval: 6000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<IpojiInboxMeta | null> => {
      const { data, error } = await supabase
        .from('ipoji_inbox')
        .select('id,row_count,created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw error
      return data
    },
  })
}

export async function loadIpojiInboxRows(id: string): Promise<unknown[]> {
  const { data, error } = await supabase.from('ipoji_inbox').select('rows').eq('id', id).single()
  if (error) throw error
  return Array.isArray(data.rows) ? data.rows : []
}

export async function clearIpojiInbox(): Promise<void> {
  // RLS scopes this to the caller's own rows.
  await supabase.from('ipoji_inbox').delete().gte('created_at', '1970-01-01')
}

// The admin's personal bookmarklet key; created on first use.
export async function getOrCreateIpojiImportKey(): Promise<string> {
  const { data, error } = await supabase.from('ipoji_import_keys').select('key').maybeSingle()
  if (error) throw error
  if (data?.key) return data.key
  const { data: created, error: rotateError } = await supabase.rpc('rotate_ipoji_import_key')
  if (rotateError || typeof created !== 'string') throw rotateError ?? new Error('no key')
  return created
}
