const AVATAR_PALETTE = [
  '#9fbe63',
  '#e8c389',
  '#a5c9e4',
  '#f7a39b',
  '#b3d880',
  '#c8b09a',
  '#9ac9a8',
  '#d4a5c0',
] as const

function hashText(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0][0] ?? ''
  const second = words.length > 1 ? words[words.length - 1][0] ?? '' : ''
  return (first + second).toUpperCase()
}

export function avatarColor(name: string): string {
  return AVATAR_PALETTE[hashText(name.trim().toLowerCase()) % AVATAR_PALETTE.length]
}
