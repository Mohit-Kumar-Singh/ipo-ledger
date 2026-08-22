import { useState } from 'react'
import { ShareAndroidIcon, CheckIcon } from '@primer/octicons-react'
import { showToast } from '../lib/toast'

const PORTAL_URL = 'https://mohit-kumar-singh-ipo-ledger.vercel.app/'
const SHARE_TITLE = 'IPO Ledger'
const SHARE_TEXT = 'IPO Ledger — track IPO applications, allotments and payouts.'

// The portal's own Open Graph image (public/og-image.png, already referenced
// by index.html's og:image meta) — reused here rather than adding a second
// asset, so the picture attached to a share matches the link preview any
// chat app would generate for the same URL anyway.
const SHARE_IMAGE_PATH = '/og-image.png'

// Tries three things in order, because "share a link with an image" means
// different things depending on where this runs:
//
//  1. navigator.share WITH the og-image as a File — the real "share sheet
//     with a picture" on Android/iOS. Gated behind canShare({ files }),
//     which is the only reliable way to know the browser will accept files;
//     passing them blind throws on desktop Chrome and older mobile browsers.
//  2. navigator.share with just title/text/url — still the native share
//     sheet, minus the attached image. Every chat app that receives it will
//     still render a link preview using og-image via the URL's own meta
//     tags, so the picture is not really lost here, just not attached as a
//     separate file.
//  3. Clipboard — desktop browsers with no Web Share API at all (Firefox,
//     most desktop Chrome). Copying the link is the honest fallback; there
//     is no share sheet to open.
//
// AbortError is swallowed throughout: the user dismissing the share sheet is
// a normal outcome, not a failure worth toasting about.
export function SharePortalButton() {
  const [copied, setCopied] = useState(false)

  async function buildImageFile(): Promise<File | null> {
    try {
      const res = await fetch(SHARE_IMAGE_PATH)
      if (!res.ok) return null
      const blob = await res.blob()
      return new File([blob], 'ipo-ledger.png', { type: blob.type || 'image/png' })
    } catch {
      return null
    }
  }

  async function handleShare() {
    const data = { title: SHARE_TITLE, text: SHARE_TEXT, url: PORTAL_URL }

    if (navigator.share) {
      const file = await buildImageFile()
      if (file && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ ...data, files: [file] })
          return
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') return
          // Fall through to the text-only share — some platforms accept
          // canShare({files}) but still reject the actual share call.
        }
      }
      try {
        await navigator.share(data)
        return
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        // Fall through to clipboard.
      }
    }

    try {
      await navigator.clipboard.writeText(PORTAL_URL)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      showToast('Portal link copied.', 'good')
    } catch {
      showToast("Couldn't share or copy the link.", 'critical')
    }
  }

  // Same 8x8 icon-button shape as ThemeToggle's iconOnly variant, which it
  // sits directly beside in the Profile header.
  return (
    <button
      type="button"
      onClick={handleShare}
      aria-label="Share the portal link"
      title={copied ? 'Link copied!' : 'Share the portal link'}
      className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--hover-surface)]"
      style={{ color: copied ? 'var(--good)' : 'var(--ink-muted)' }}
    >
      {copied ? <CheckIcon size={16} /> : <ShareAndroidIcon size={16} />}
    </button>
  )
}
