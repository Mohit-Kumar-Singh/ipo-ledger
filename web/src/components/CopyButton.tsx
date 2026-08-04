import { useEffect, useRef, useState } from 'react'
import { IconButton } from '@primer/react'
import { CheckIcon, CopyIcon } from '@primer/octicons-react'

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timeoutRef.current), [])

  async function handleCopy() {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => setCopied(false), 1200)
  }

  return (
    <IconButton
      size="small"
      variant="invisible"
      onClick={handleCopy}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      icon={copied ? CheckIcon : CopyIcon}
    />
  )
}
