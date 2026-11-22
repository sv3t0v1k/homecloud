import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { avatarColor, initialsOf } from './avatarUtils'
import { InitialsAvatar } from './InitialsAvatar'

describe('InitialsAvatar', () => {
  afterEach(cleanup)

  it('renders one initial for a single-word name', () => {
    const { container } = render(<InitialsAvatar name="Алексей" />)
    expect(container.querySelector('.initials-avatar')).toHaveTextContent('А')
  })

  it('renders two initials for a multi-word name', () => {
    const { container } = render(<InitialsAvatar name="Иван Петров" />)
    expect(container.querySelector('.initials-avatar')).toHaveTextContent('ИП')
  })

  it('falls back to a question mark for an empty name', () => {
    const { container } = render(<InitialsAvatar name="   " />)
    expect(container.querySelector('.initials-avatar')).toHaveTextContent('?')
  })

  it('is hidden from assistive technology', () => {
    const { container } = render(<InitialsAvatar name="Алексей" />)
    expect(container.querySelector('.initials-avatar')).toHaveAttribute('aria-hidden', 'true')
  })

  it('keeps the color stable for the same name and varies across distinct names', () => {
    expect(avatarColor('Алексей')).toBe(avatarColor('алексей'))
    const colors = new Set(['Анна', 'Борис', 'Вера', 'Григорий', 'Дарья'].map(avatarColor))
    expect(colors.size).toBeGreaterThan(1)
  })

  it('computes initials without crashing on unicode', () => {
    expect(initialsOf('Мария-Ева Соколова')).toBe('МС')
    expect(initialsOf('')).toBe('?')
  })
})
