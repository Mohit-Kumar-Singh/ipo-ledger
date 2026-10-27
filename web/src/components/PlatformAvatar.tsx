import { useState } from 'react'
import { PLATFORM_LOGOS, platformLabel, type DematPlatform } from '../lib/platforms'

// Round account avatar: the trading platform's logo when the account has a
// platform set and its logo file exists, otherwise the holder's initial on
// the usual gradient. A logo that fails to load (file not added yet, bad
// path) quietly falls back to the initial instead of a broken image.
export function PlatformAvatar({
  platform,
  name,
  className = 'h-8 w-8 text-xs',
}: {
  platform: DematPlatform | string | null | undefined
  name: string
  className?: string
}) {
  const logo = platform ? PLATFORM_LOGOS[platform as DematPlatform] : undefined
  const [failedLogo, setFailedLogo] = useState<string | null>(null)

  if (logo && failedLogo !== logo) {
    return (
      <img
        src={logo}
        alt={platformLabel(platform)}
        title={platformLabel(platform)}
        onError={() => setFailedLogo(logo)}
        className={`${className} shrink-0 rounded-full bg-white object-contain`}
        style={{ border: '1px solid var(--separator)' }}
      />
    )
  }

  return (
    <div
      className={`${className} flex shrink-0 items-center justify-center rounded-full font-semibold`}
      style={{ background: 'linear-gradient(135deg, var(--violet), var(--accent))', color: 'white' }}
    >
      {name[0]?.toUpperCase()}
    </div>
  )
}
