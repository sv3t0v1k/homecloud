import { useMemo } from 'react'

import { createQrMatrix } from './qrCode'

/** SVG-представление QR-кода с quiet zone в 4 модуля. */
export function QrCodeImage({ value, size = 168, label }: { value: string; size?: number; label: string }) {
  const quiet = 4
  const rendered = useMemo(() => {
    let matrix
    try {
      matrix = createQrMatrix(value)
    } catch {
      return null
    }
    const parts: string[] = []
    matrix.modules.forEach((row, r) => {
      row.forEach((dark, c) => {
        if (dark) parts.push(`M${c + quiet} ${r + quiet}h1v1h-1z`)
      })
    })
    return { path: parts.join(''), total: matrix.size + quiet * 2 }
  }, [value])
  if (!rendered) return <p className="muted">Ссылка слишком длинная для QR-кода.</p>
  const { path, total } = rendered
  return (
    <svg
      aria-label={label}
      className="qr-code-image"
      height={size}
      role="img"
      viewBox={`0 0 ${total} ${total}`}
      width={size}
    >
      <rect fill="#ffffff" height={total} width={total} x={0} y={0} />
      <path d={path} fill="#161715" />
    </svg>
  )
}
