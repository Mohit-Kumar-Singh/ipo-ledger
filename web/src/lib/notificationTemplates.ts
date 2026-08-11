// Client-side reconstruction of the Meta-approved WhatsApp template bodies
// (see 04-api-and-functions.md §4), used only for the member self-send path
// (wa.me deep link — a plain pre-filled compose box, not the Business API,
// so no template approval is needed here). No sign-off name — the message
// is already going out from the sender's own WhatsApp number/contact card,
// so appending their name again on every single message was redundant.

export type TemplateName =
  | 'ipo_applied'
  | 'ipo_allotted'
  | 'ipo_applied_funder'
  | 'ipo_allotted_funder'
  // Old name for ipo_applied_funder, kept only so historic notification
  // rows created before this rename still render instead of falling
  // through to the raw params-joined default.
  | 'ipo_applied_bank_holder'

// The portal's own origin, appended to every template body below so the
// recipient has somewhere to go for details beyond what fits in a WhatsApp
// message (status, mandate approval, etc.) — window.location.origin rather
// than a hardcoded domain so this stays correct across dev/preview/prod
// without a separate env var to keep in sync.
function portalLine(): string {
  if (typeof window === 'undefined') return ''
  return `\n\nDetails: ${window.location.origin}`
}

export function renderMessageBody(templateName: string, params: string[]): string {
  const p = (i: number) => params[i] ?? ''
  switch (templateName) {
    case 'ipo_applied':
      return (
        `Hi ${p(0)}, I've applied for the *${p(1)}* IPO from your account using ${p(2)} — ${p(3)}. ` +
        `You may get a UPI/ASBA mandate request from your bank; please approve it today so the ` +
        `application goes through. The amount stays blocked in your account until allotment.` +
        portalLine()
      )
    case 'ipo_allotted':
      return (
        `Hi ${p(0)}, good news! The *${p(1)}* IPO applied from your account has been *ALLOTTED* 🎉 (${p(2)}). ` +
        `Listing date: *${p(3)}*. Plan: sell on listing day — I'll message you that morning. Shares will be ` +
        `visible in your demat by listing.` +
        portalLine()
      )
    case 'ipo_applied_funder':
    case 'ipo_applied_bank_holder':
      return (
        `Hi ${p(0)}, heads up — I've used your bank/UPI account for ${p(2)}'s *${p(1)}* IPO application (${p(3)}). ` +
        `You may get a UPI/ASBA mandate request from your bank; please approve it today.` +
        portalLine()
      )
    case 'ipo_allotted_funder':
      return (
        `Hi ${p(0)}, good news! ${p(2)}'s *${p(1)}* IPO, funded through your account, has been *ALLOTTED* 🎉. ` +
        `Listing date: *${p(3)}*.` +
        portalLine()
      )
    case 'ipo_close_rollup':
      // Body built server-side in full (grouped by application date, one
      // line per demat account) — passed through as a single param rather
      // than positional pieces, since the shape (N accounts, each on its
      // own date) doesn't fit the fixed p(0)/p(1)/p(2)/p(3) slots every
      // other template uses.
      return `${p(0)}${portalLine()}`
    default:
      return params.join(' · ')
  }
}

export function buildWaMeLink(phoneE164: string, text: string): string {
  const digits = phoneE164.replace(/[^0-9]/g, '')
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}
