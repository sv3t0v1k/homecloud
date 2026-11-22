import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getStorageInfo } from './api'
import { QuotaBadge } from './QuotaBadge'

vi.mock('./api', () => ({
  getStorageInfo: vi.fn(),
}))

describe('QuotaBadge', () => {
  beforeEach(() => {
    vi.mocked(getStorageInfo).mockReset()
  })

  afterEach(cleanup)

  it('renders nothing while loading or on error', async () => {
    vi.mocked(getStorageInfo).mockRejectedValue(new Error('offline'))
    const { container } = render(<QuotaBadge />)
    expect(container.querySelector('.quota-badge')).toBeNull()
    await waitFor(() => expect(getStorageInfo).toHaveBeenCalled())
    expect(container.querySelector('.quota-badge')).toBeNull()
  })

  it('shows usage percent with an ok level below 70%', async () => {
    vi.mocked(getStorageInfo).mockResolvedValue({
      storageUsed: '536870912', storageQuota: '1073741824', fileCount: 1, folderCount: 1,
    })
    const { container } = render(<QuotaBadge />)
    const badge = await screen.findByRole('status')
    expect(badge).toHaveTextContent('50%')
    expect(container.querySelector('.quota-badge')).toHaveAttribute('data-level', 'ok')
  })

  it('switches to warning level from 70%', async () => {
    vi.mocked(getStorageInfo).mockResolvedValue({
      storageUsed: '805306368', storageQuota: '1073741824', fileCount: 1, folderCount: 1,
    })
    const { container } = render(<QuotaBadge />)
    await screen.findByRole('status')
    expect(container.querySelector('.quota-badge')).toHaveAttribute('data-level', 'warning')
  })

  it('switches to danger level from 85%', async () => {
    vi.mocked(getStorageInfo).mockResolvedValue({
      storageUsed: '966367641', storageQuota: '1073741824', fileCount: 1, folderCount: 1,
    })
    const { container } = render(<QuotaBadge />)
    await screen.findByRole('status')
    expect(container.querySelector('.quota-badge')).toHaveAttribute('data-level', 'danger')
  })

  it('exposes an accessible summary of used and total bytes', async () => {
    vi.mocked(getStorageInfo).mockResolvedValue({
      storageUsed: '536870912', storageQuota: '1073741824', fileCount: 1, folderCount: 1,
    })
    render(<QuotaBadge />)
    const badge = await screen.findByRole('status')
    expect(badge).toHaveTextContent(/Занято .* из .*/)
  })
})
