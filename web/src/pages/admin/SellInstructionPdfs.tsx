import { useEffect, useRef, useState } from 'react'
import { FileIcon, ChevronDownIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { showToast } from '../../lib/toast'
import { confirmDialog } from '../../lib/confirmDialog'
import { InfoTooltip } from '../../components/HoverCard'
import { PDF_PLATFORMS, PLATFORM_LABELS, type DematPlatform } from '../../lib/platforms'

const BUCKET = 'sell-instructions'

type PdfRow = { platform: DematPlatform; storage_path: string; updated_at: string }

// PDF or any image (a lot of platforms' T-PIN/sell steps are more naturally
// shared as a screenshot than a formatted document) — null for anything else.
function extensionFor(file: File): string | null {
  if (file.type === 'application/pdf') return 'pdf'
  if (file.type.startsWith('image/')) {
    const sub = file.type.split('/')[1] || 'jpg'
    return sub === 'jpeg' ? 'jpg' : sub
  }
  return null
}

// Admin-only library of one how-to-verify-with-T-PIN + how-to-sell PDF per
// trading platform, reused across every IPO's listing-day sell reminders. A
// platform with no PDF is a valid state — the send flow just goes text-only
// for holders on it. RLS (migration 0075) is the real boundary; this section
// is simply hidden for non-admins by its caller.
export function SellInstructionPdfsSection() {
  const [rows, setRows] = useState<Record<string, PdfRow>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<DematPlatform | null>(null)
  // Collapsed by default — a rarely-touched library that sits at the very
  // bottom of Profile, so it shouldn't take up room until opened.
  const [open, setOpen] = useState(false)

  async function load() {
    const { data, error } = await supabase.from('sell_instruction_pdfs').select('platform, storage_path, updated_at')
    if (error) {
      showToast(`Couldn't load sell-instruction PDFs: ${error.message}`, 'critical')
      setLoading(false)
      return
    }
    const map: Record<string, PdfRow> = {}
    for (const r of (data ?? []) as PdfRow[]) map[r.platform] = r
    setRows(map)
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function handleUpload(platform: DematPlatform, file: File) {
    const ext = extensionFor(file)
    if (!ext) {
      showToast('Please choose a PDF or image file.', 'warning')
      return
    }
    setBusy(platform)
    // Stable per-platform path, but now suffixed by the actual file's
    // extension (was always `.pdf`) — so switching a platform from a PDF to
    // an image (or back) changes the storage key. upsert only overwrites in
    // place when the key matches, so remove the previous object first when
    // the extension actually changed, otherwise it'd be left orphaned in
    // the bucket even though the row below now points elsewhere.
    const path = `${platform}.${ext}`
    const prev = rows[platform]
    if (prev && prev.storage_path !== path) {
      await supabase.storage.from(BUCKET).remove([prev.storage_path])
    }
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type })
    if (upErr) {
      showToast(`Upload failed: ${upErr.message}`, 'critical')
      setBusy(null)
      return
    }
    const { error: rowErr } = await supabase.from('sell_instruction_pdfs').upsert(
      {
        platform,
        storage_path: path,
        uploaded_by: (await supabase.auth.getUser()).data.user?.id ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'platform' },
    )
    if (rowErr) {
      showToast(`Saved the file but couldn't record it: ${rowErr.message}`, 'critical')
    } else {
      showToast(`${PLATFORM_LABELS[platform]} sell-instruction file updated.`, 'good')
    }
    setBusy(null)
    load()
  }

  async function handleRemove(platform: DematPlatform) {
    const row = rows[platform]
    if (!row) return
    if (!(await confirmDialog(`Remove the ${PLATFORM_LABELS[platform]} sell-instruction file?`, { tone: 'critical', confirmLabel: 'Remove' })))
      return
    setBusy(platform)
    await supabase.storage.from(BUCKET).remove([row.storage_path])
    const { error } = await supabase.from('sell_instruction_pdfs').delete().eq('platform', platform)
    if (error) showToast(`Couldn't remove: ${error.message}`, 'critical')
    else showToast(`${PLATFORM_LABELS[platform]} sell-instruction file removed.`, 'good')
    setBusy(null)
    load()
  }

  async function handleOpen(platform: DematPlatform) {
    const row = rows[platform]
    if (!row) return
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(row.storage_path, 300)
    if (error || !data?.signedUrl) {
      showToast(`Couldn't open: ${error?.message ?? 'no signed URL'}`, 'critical')
      return
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  const uploadedCount = Object.keys(rows).length

  // Same collapsible-card shape as the PAN access-log card: icon + title +
  // (i) tooltip in the header, a rotating chevron, and the body in a
  // border-top section. overflow-visible so the tooltip popup isn't clipped.
  return (
    <section className="card animate-page-in overflow-visible">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-4 text-left transition-colors hover:bg-[var(--hover-surface)]"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          <FileIcon size={16} fill="var(--accent)" />
          Sell-instruction PDFs
          <InfoTooltip text="One how-to-verify-with-T-PIN + how-to-sell PDF per platform, auto-attached to listing-day sell reminders based on each holder's saved platform. A platform with no PDF still gets a text-only reminder." />
          {!loading && <span className="badge badge-neutral">{uploadedCount}/{PDF_PLATFORMS.length}</span>}
        </span>
        <span
          className="inline-flex transition-transform duration-200"
          style={{ color: 'var(--ink-muted)', transform: open ? 'rotate(180deg)' : undefined }}
        >
          <ChevronDownIcon size={16} />
        </span>
      </button>
      {open && (
        <div className="border-t p-4" style={{ borderColor: 'var(--border)' }}>
          {loading ? (
            <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
              Loading…
            </p>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {PDF_PLATFORMS.map((platform) => (
                <PdfRowUI
                  key={platform}
                  platform={platform}
                  row={rows[platform]}
                  busy={busy === platform}
                  onUpload={handleUpload}
                  onRemove={handleRemove}
                  onOpen={handleOpen}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function PdfRowUI({
  platform,
  row,
  busy,
  onUpload,
  onRemove,
  onOpen,
}: {
  platform: DematPlatform
  row: PdfRow | undefined
  busy: boolean
  onUpload: (platform: DematPlatform, file: File) => void
  onRemove: (platform: DematPlatform) => void
  onOpen: (platform: DematPlatform) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <div className="min-w-0">
        <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
          {PLATFORM_LABELS[platform]}
        </p>
        <p className="text-xs" style={{ color: row ? 'var(--good)' : 'var(--ink-muted)' }}>
          {row ? `Uploaded · ${new Date(row.updated_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'No file'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {row && (
          <button type="button" onClick={() => onOpen(platform)} disabled={busy} className="link-accent text-xs font-medium disabled:opacity-50">
            Open
          </button>
        )}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="text-xs font-medium hover:underline disabled:opacity-50"
          style={{ color: 'var(--ink-secondary)' }}
        >
          {busy ? 'Working…' : row ? 'Replace' : 'Upload'}
        </button>
        {row && (
          <button
            type="button"
            onClick={() => onRemove(platform)}
            disabled={busy}
            className="text-xs font-medium hover:underline disabled:opacity-50"
            style={{ color: 'var(--critical)' }}
          >
            Remove
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onUpload(platform, file)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
