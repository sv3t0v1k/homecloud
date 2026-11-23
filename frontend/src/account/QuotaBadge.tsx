import { useEffect, useRef, useState } from 'react'

import { formatBytes, storagePercent } from '../ui/formatBytes'
import { getStorageInfo, type StorageInfo } from './api'

type QuotaState =
  | { status: 'loading' }
  | { status: 'ready'; info: StorageInfo }
  | { status: 'error' }

export function QuotaBadge() {
  const [state, setState] = useState<QuotaState>({ status: 'loading' })
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const controller = new AbortController()

    function load() {
      void getStorageInfo(controller.signal)
        .then((info) => {
          if (alive.current && !controller.signal.aborted) setState({ status: 'ready', info })
        })
        .catch(() => {
          if (alive.current && !controller.signal.aborted) setState({ status: 'error' })
        })
    }

    function onFocus() {
      load()
    }

    load()
    window.addEventListener('focus', onFocus)
    return () => {
      alive.current = false
      controller.abort()
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  if (state.status !== 'ready') return null

  const percent = storagePercent(state.info.storageUsed, state.info.storageQuota)
  if (percent === null) return null

  const level = percent >= 85 ? 'danger' : percent >= 70 ? 'warning' : 'ok'
  const used = formatBytes(state.info.storageUsed)
  const quota = formatBytes(state.info.storageQuota)

  return (
    <span
      className="quota-badge"
      data-level={level}
      role="status"
      title={`Занято ${used} из ${quota}`}
    >
      <span className="quota-badge-track" aria-hidden="true">
        <span className="quota-badge-fill" style={{ width: `${Math.min(100, percent)}%` }} />
      </span>
      <span className="quota-badge-value">{percent}%</span>
      <span className="sr-only">
        {`Занято ${used} из ${quota} (${percent}%)`}
      </span>
    </span>
  )
}
