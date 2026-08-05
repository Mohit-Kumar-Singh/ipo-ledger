import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Profile } from '../types/database'

interface AuthContextValue {
  session: Session | null
  profile: Profile | null
  loading: boolean
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

// The handle_new_user DB trigger normally creates a profiles row the moment
// auth.users gets one — but it can silently fail to fire for a given signup
// without erroring the signup itself, leaving an account stuck
// signed-in-but-broken (every page reading `profile` sees perpetual null,
// which looks like "can't log in" from the user's side). If the row is
// missing, self-heal via ensure_own_profile() (idempotent, same insert the
// trigger does) and refetch once before giving up.
async function fetchOrHealProfile(userId: string): Promise<Profile | null> {
  const first = await supabase.from('profiles').select('*').eq('id', userId).single()
  if (first.data) return first.data as Profile

  await supabase.rpc('ensure_own_profile')
  const healed = await supabase.from('profiles').select('*').eq('id', userId).single()
  return (healed.data as Profile | null) ?? null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  // Only reflects session resolution (fast — supabase-js reads this from
  // local storage, no network round trip) so ProtectedRoute can mount the
  // actual page as soon as we know the user is signed in, instead of also
  // blocking on the profile row. Page components already treat `profile`
  // as possibly-null via optional chaining (isAdmin = profile?.role ===
  // 'admin', etc.), so their own data fetches — which only need
  // session.user.id, not the profile object — now run concurrently with
  // the profile fetch instead of waiting behind it. Previously this was a
  // strict 3-step serial waterfall (session -> profile -> page data) on
  // every fresh load; profile now loads in parallel with page data.
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      setLoading(false)
      if (!newSession) setProfile(null)
    })

    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return
    let cancelled = false
    fetchOrHealProfile(session.user.id).then((data) => {
      if (!cancelled) setProfile(data)
    })
    return () => {
      cancelled = true
    }
  }, [session])

  async function signOut() {
    await supabase.auth.signOut()
  }

  async function refreshProfile() {
    if (!session) return
    setProfile(await fetchOrHealProfile(session.user.id))
  }

  return (
    <AuthContext.Provider value={{ session, profile, loading, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
