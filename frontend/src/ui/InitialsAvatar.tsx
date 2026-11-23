import { avatarColor, initialsOf } from './avatarUtils'

export function InitialsAvatar({ name, size = 22 }: { name: string; size?: number }) {
  const initials = initialsOf(name)
  return (
    <span
      aria-hidden="true"
      className="initials-avatar"
      style={{
        width: size,
        height: size,
        background: avatarColor(name),
        fontSize: Math.max(9, Math.round(size * 0.42)),
      }}
    >
      {initials}
    </span>
  )
}
