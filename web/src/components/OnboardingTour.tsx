import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BellIcon,
  ChecklistIcon,
  FileIcon,
  LawIcon,
  HomeIcon,
  SparklesFillIcon,
  GraphIcon,
  PeopleIcon,
  XIcon,
  type Icon,
} from '@primer/octicons-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { showToast } from '../lib/toast'

interface Step {
  target: string | null // matches a [data-tour] value in AppShell's sidebar, or null to just dim the page
  icon: Icon
  title: string
  body: string
}

function steps(isAdmin: boolean): Step[] {
  return [
    {
      target: null,
      icon: SparklesFillIcon,
      title: 'Welcome to IPO Ledger',
      body: "Let's highlight what's in the sidebar. Skip anytime — you can always find your way around from here.",
    },
    {
      target: '/',
      icon: HomeIcon,
      title: 'Dashboard',
      body: 'A snapshot of open IPOs, recent applications, and allotment activity as soon as you sign in.',
    },
    {
      // No sidebar nav item to point at anymore — Accounts moved into a
      // collapsible section at the bottom of Profile, reached via the
      // identity card up top rather than its own nav entry.
      target: null,
      icon: PeopleIcon,
      title: 'Accounts',
      body: isAdmin
        ? 'Manage demat accounts and holders — link users, set profit share, and mark accounts active or inactive. Find it in a collapsible section at the bottom of your Profile page.'
        : 'View the demat accounts linked to you and their details, in a collapsible section at the bottom of your Profile page.',
    },
    {
      target: '/bank-accounts',
      icon: LawIcon,
      title: 'Bank / UPI accounts',
      body: 'Keep bank and UPI details on file for payouts, linked to the right demat holder.',
    },
    {
      target: '/ipos',
      icon: GraphIcon,
      title: 'IPOs',
      body: 'Browse upcoming and ongoing IPOs with issue size, price band, and key dates.',
    },
    {
      target: '/applications',
      icon: FileIcon,
      title: 'Applications',
      body: 'Track every IPO application by category and status, from applied through allotted or sold.',
    },
    {
      target: '/allotment',
      icon: ChecklistIcon,
      title: 'Allotment board',
      body: 'See allotment results across all your accounts in one place, with payout status.',
    },
    {
      target: '/notifications',
      icon: BellIcon,
      title: 'Notifications',
      body: 'WhatsApp updates for applications, allotments, and sell reminders land here.',
    },
  ]
}

const MOBILE_BREAKPOINT = 768
const DRAWER_TRANSITION_MS = 320
const SPOTLIGHT_PADDING = 6

interface OnboardingTourProps {
  onRequireNavOpen: (open: boolean) => void
  onActiveChange: (active: boolean) => void
}

export function OnboardingTour({ onRequireNavOpen, onActiveChange }: OnboardingTourProps) {
  const { profile, refreshProfile } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)

  const active = !!profile && !profile.has_seen_tour && !dismissed
  const slides = profile ? steps(profile.role === 'admin') : []
  const current = active ? slides[step] : undefined

  useEffect(() => {
    onActiveChange(active)
    if (!active) onRequireNavOpen(false)
  }, [active, onActiveChange, onRequireNavOpen])

  // Lock page scroll while the tour is up so the spotlight ring can't drift
  // out of sync with its target.
  useEffect(() => {
    if (!active) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [active])

  useEffect(() => {
    if (!active || !current) return
    if (!current.target) {
      setRect(null)
      onRequireNavOpen(false)
      return
    }

    // Actually navigate to the page being highlighted, so the step shows the
    // real feature behind the sidebar link, not just the nav item itself.
    navigate(current.target)

    const isMobile = window.innerWidth < MOBILE_BREAKPOINT
    if (isMobile) onRequireNavOpen(true)

    const measure = () => {
      const el = document.querySelector(`[data-tour="${current.target}"]`)
      if (el) setRect(el.getBoundingClientRect())
    }
    const timer = window.setTimeout(measure, isMobile ? DRAWER_TRANSITION_MS : 0)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', measure)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, step, onRequireNavOpen])

  if (!active || !current) return null

  const isLast = step === slides.length - 1
  const Icon = current.icon

  function finish() {
    setDismissed(true)
    navigate('/')
    supabase
      .rpc('mark_tour_seen')
      .then(({ error }) => {
        if (error) {
          showToast("Couldn't save that you've seen the intro — it may show again next time.", 'warning')
          return
        }
        refreshProfile()
      })
  }

  return (
    <>
      {rect ? (
        <>
          {/* Blocks clicks on the dimmed page so the real nav link underneath
              can't be clicked and desync the tour from its step — Next/Back
              in the panel are the only way to move. */}
          <div className="fixed inset-0 z-[54]" />
          <div
            className="fixed z-[55] rounded-xl transition-all duration-200"
            style={{
              top: rect.top - SPOTLIGHT_PADDING,
              left: rect.left - SPOTLIGHT_PADDING,
              width: rect.width + SPOTLIGHT_PADDING * 2,
              height: rect.height + SPOTLIGHT_PADDING * 2,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)',
              border: '2px solid var(--accent)',
              pointerEvents: 'none',
            }}
          />
        </>
      ) : (
        <div className="fixed inset-0 z-[55]" style={{ background: 'rgba(0,0,0,0.6)' }} />
      )}

      <div
        className="card fixed inset-x-4 bottom-4 z-[60] p-5 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-80"
        style={{ background: 'var(--surface)' }}
      >
        <button
          onClick={finish}
          aria-label="Skip intro"
          className="absolute top-3 right-3 rounded-lg p-1.5"
          style={{ color: 'var(--ink-muted)' }}
        >
          <XIcon size={18} />
        </button>

        <div
          className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl"
          style={{ background: 'linear-gradient(135deg, var(--btn-primary-bg), var(--accent))', color: 'white' }}
        >
          <Icon size={20} />
        </div>

        <h2 className="text-base font-semibold" style={{ color: 'var(--ink-primary)' }}>
          {current.title}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
          {current.body}
        </p>

        <div className="mt-6 flex items-center justify-between">
          <div className="flex gap-1.5">
            {slides.map((_, i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: i === step ? 'var(--accent)' : 'var(--border-strong)' }}
              />
            ))}
          </div>

          <div className="flex gap-2">
            {step > 0 && (
              <button onClick={() => setStep((s) => s - 1)} className="btn-secondary">
                Back
              </button>
            )}
            {isLast ? (
              <button onClick={finish} className="btn-primary">
                Get started
              </button>
            ) : (
              <button onClick={() => setStep((s) => s + 1)} className="btn-primary">
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
