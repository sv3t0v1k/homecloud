import { useEffect, useRef, useState } from 'react'

import { ApiError } from '../api/errors'
import { useDialogFocus } from '../accessibility/useDialogFocus'
import type { FileItem } from '../types/files'
import { getFilePreview, previewImageBlob, previewVideoBlob, type PreviewPayload } from './preview'
import { BinaryPreviewTooLargeError, fetchFileBlob } from './download'
import { Icon } from '../ui/Icon'
import { LiquidCloseButton } from '../ui/LiquidCloseButton'

export type PreviewFile = Pick<FileItem, 'id' | 'name'> &
  Partial<Pick<FileItem, 'mimeType' | 'size'>>

type PreviewState =
  | { status: 'loading' }
  | {
      status: 'ready'
      preview: PreviewPayload
      imageUrl?: string
      videoUrl?: string
      imageLoaded?: boolean
      binaryUrl?: string
      binaryKind?: 'pdf' | 'audio'
    }
  | { status: 'error'; message: string }

const MIN_ZOOM = 0.2
const MAX_ZOOM = 5
const ZOOM_STEP = 1.25

export function PreviewModal({
  file,
  siblings,
  onClose,
}: {
  file: PreviewFile
  /** Упорядоченный список файлов для листания стрелками (обычно содержимое папки). */
  siblings?: PreviewFile[]
  onClose(): void
}) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const [currentId, setCurrentId] = useState(file.id)
  const [zoom, setZoom] = useState<number | null>(null)
  const [naturalWidth, setNaturalWidth] = useState<number>()
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const zoomSurfaceRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setCurrentId(file.id)
  }, [file.id])

  const siblingMatch = siblings?.find((item) => item.id === currentId)
  const current: PreviewFile = siblingMatch ?? (currentId === file.id ? file : { ...file, id: currentId })
  const index = siblings ? siblings.findIndex((item) => item.id === currentId) : -1
  const canNavigatePrev = index > 0
  const canNavigateNext = siblings !== undefined && index >= 0 && index < siblings.length - 1

  const waitingForImage =
    state.status === 'ready' &&
    state.preview.type === 'image' &&
    Boolean(state.imageUrl) &&
    !state.imageLoaded
  const waitingForVideo =
    state.status === 'ready' &&
    state.preview.type === 'video' &&
    Boolean(state.videoUrl)
  const closingAnimation = useRef<Animation | null>(null)
  const dialogRef = useDialogFocus(close, closeButtonRef)

  useEffect(() => {
    return () => {
      const animation = closingAnimation.current
      closingAnimation.current = null
      animation?.cancel()
    }
  }, [currentId])

  function close() {
    if (closingAnimation.current) return

    const overlay = dialogRef.current

    if (
      !overlay ||
      typeof overlay.animate !== 'function' ||
      window.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches
    ) {
      onClose()
      return
    }

    try {
      // Fade the entire preview, including its backdrop.
      const animation = overlay.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        {
          duration: 450,
          easing: 'cubic-bezier(.4,0,.3,1)',
          fill: 'both',
        },
      )

      closingAnimation.current = animation

      const finish = () => {
        if (closingAnimation.current !== animation) return
        onClose()
      }

      void animation.finished.then(finish, finish)
    } catch {
      onClose()
    }
  }

  function navigate(step: number) {
    if (!siblings || index < 0) return
    const target = siblings[index + step]
    if (target) setCurrentId(target.id)
  }

  function adjustZoom(direction: 1 | -1) {
    setZoom((current) => {
      const base = current ?? 1
      const next = direction > 0 ? base * ZOOM_STEP : base / ZOOM_STEP
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
    })
  }

  const showZoomToolbar =
    state.status === 'ready' &&
    state.preview.type === 'image' &&
    Boolean(state.imageUrl) &&
    Boolean(state.imageLoaded)

  // Листание стрелками ловим на документе: после навигации кнопка может стать
  // disabled и потерять фокус, поэтому keydown на оверлее не сработает.
  useEffect(() => {
    if (!siblings || siblings.length < 2) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (event.key === 'ArrowLeft' && canNavigatePrev) {
        event.preventDefault()
        navigate(-1)
      } else if (event.key === 'ArrowRight' && canNavigateNext) {
        event.preventDefault()
        navigate(1)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siblings, index, canNavigatePrev, canNavigateNext])

  // Ctrl+колесо масштабирует изображение, обычная прокрутка скроллит область.
  useEffect(() => {
    if (!showZoomToolbar) return
    const surface = zoomSurfaceRef.current
    if (!surface) return
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey) return
      event.preventDefault()
      adjustZoom(event.deltaY < 0 ? 1 : -1)
    }
    surface.addEventListener('wheel', onWheel, { passive: false })
    return () => surface.removeEventListener('wheel', onWheel)
  }, [showZoomToolbar])

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    setState({ status: 'loading' })
    setZoom(null)
    setNaturalWidth(undefined)

    const binaryKind = detectBinaryKind(current)
    if (binaryKind) {
      fetchFileBlob(
        { id: current.id, name: current.name, size: current.size ?? 0 },
        current.mimeType ?? 'application/octet-stream',
        controller.signal,
      )
        .then((blob) => {
          if (controller.signal.aborted) return
          objectUrl = URL.createObjectURL(blob)
          setState({
            status: 'ready',
            preview: { type: 'unsupported', content: '', mimeType: current.mimeType ?? '' },
            binaryUrl: objectUrl,
            binaryKind,
          })
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setState({
            status: 'error',
            message:
              error instanceof BinaryPreviewTooLargeError
                ? 'Файл слишком большой для предпросмотра.'
                : previewErrorMessage(error),
          })
        })
    } else {
      getFilePreview(current.id, controller.signal)
        .then((preview) => {
          if (controller.signal.aborted) return
          if (preview.type === 'image') {
            objectUrl = URL.createObjectURL(previewImageBlob(preview))
          } else if (preview.type === 'video') {
            objectUrl = URL.createObjectURL(previewVideoBlob(preview))
          }
          setState({
            status: 'ready',
            preview,
            imageUrl: preview.type === 'image' ? objectUrl : undefined,
            videoUrl: preview.type === 'video' ? objectUrl : undefined,
          })
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setState({ status: 'error', message: previewErrorMessage(error) })
        })
    }

    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    // Зависимости — примитивные поля current: сам объект собирается заново каждый рендер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id, current.mimeType, current.name, current.size])

  return (
    <div
      aria-labelledby="preview-title"
      aria-modal="true"
      className="dialog-overlay preview-overlay"
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <div
        className="dialog-surface preview-dialog"
        data-preview-image={
          current.mimeType?.startsWith('image/') ||
          current.mimeType?.startsWith('video/') ||
          (state.status === 'ready' &&
            (state.preview.type === 'image' ||
              state.preview.type === 'video'))
            ? 'true'
            : undefined
        }
      >
        <div className="dialog-header">
          <div className="preview-heading">
            <h3 className="preview-title" id="preview-title">Просмотр: {current.name}</h3>
            {siblings && siblings.length > 1 && index >= 0 ? (
              <span className="preview-counter">{index + 1} из {siblings.length}</span>
            ) : null}
          </div>
          {siblings && siblings.length > 1 ? (
            <div className="preview-nav" role="group" aria-label="Листание файлов">
              <button
                aria-label="Предыдущий файл"
                className="icon-button"
                disabled={!canNavigatePrev}
                onClick={() => navigate(-1)}
                title="Предыдущий файл (←)"
                type="button"
              >
                <Icon name="chevron-left" />
              </button>
              <button
                aria-label="Следующий файл"
                className="icon-button"
                disabled={!canNavigateNext}
                onClick={() => navigate(1)}
                title="Следующий файл (→)"
                type="button"
              >
                <Icon name="chevron" />
              </button>
            </div>
          ) : null}
          <LiquidCloseButton
            aria-label="Закрыть просмотр"
            onClick={close}
            ref={closeButtonRef}
            title="Закрыть просмотр"
          />
        </div>
        <div className="dialog-body preview-content">
        {state.status === 'loading' || waitingForImage || waitingForVideo ? (
          <div className="preview-loader" role="status">
            <span className="preview-loader-orbit" aria-hidden="true">
              <Icon name="cloud" width={32} height={32} />
            </span>
            <p className="preview-loader-label">
              Загружаем предпросмотр…
            </p>
          </div>
        ) : null}
        {state.status === 'error' ? <p className="alert alert--danger" role="alert">{state.message}</p> : null}
        {showZoomToolbar ? (
          <div className="preview-zoom-toolbar" role="group" aria-label="Масштаб изображения">
            <button
              aria-label="Уменьшить"
              className="icon-button"
              disabled={zoom !== null && zoom <= MIN_ZOOM}
              onClick={() => adjustZoom(-1)}
              type="button"
            >
              <Icon name="zoom-out" />
            </button>
            <button
              className="preview-zoom-reset"
              disabled={zoom === null}
              onClick={() => setZoom(null)}
              title="Вписать в окно"
              type="button"
            >
              {zoom === null ? 'По размеру' : `${Math.round(zoom * 100)}%`}
            </button>
            <button
              aria-label="Увеличить"
              className="icon-button"
              disabled={zoom !== null && zoom >= MAX_ZOOM}
              onClick={() => adjustZoom(1)}
              type="button"
            >
              <Icon name="zoom-in" />
            </button>
          </div>
        ) : null}
        {state.status === 'ready' && state.preview.type === 'text' ? (
          <pre className="preview-text mono">{state.preview.content}</pre>
        ) : null}
        {state.status === 'ready' && state.preview.type === 'image' && state.imageUrl ? (
          <div className="preview-zoom-surface" ref={zoomSurfaceRef}>
          <img
            alt={`Предпросмотр: ${current.name}`}
            key={state.imageUrl}
            className="preview-image"
            src={state.imageUrl}
            style={zoom !== null && naturalWidth ? { width: Math.round(naturalWidth * zoom), maxWidth: 'none' } : undefined}
            data-image-pending={waitingForImage ? 'true' : undefined}
            onLoad={(event) => {
              setNaturalWidth(event.currentTarget.naturalWidth || undefined)
              setState(current =>
                current.status === 'ready' &&
                current.imageUrl === state.imageUrl
                  ? { ...current, imageLoaded: true }
                  : current,
              )
            }}
            onError={() => {
              setState(current =>
                current.status === 'ready' &&
                current.imageUrl === state.imageUrl
                  ? {
                      status: 'error',
                      message: 'Не удалось отобразить изображение.',
                    }
                  : current,
              )
            }}
          />
          </div>
        ) : null}
        {state.status === 'ready' && state.preview.type === 'video' && state.videoUrl ? (
          <img
            alt={`Предпросмотр: ${current.name}`}
            key={state.videoUrl}
            className="preview-image"
            src={state.videoUrl}
            data-image-pending={waitingForVideo ? 'true' : undefined}
            onLoad={() => {
              setState(current =>
                current.status === 'ready' &&
                current.videoUrl === state.videoUrl
                  ? { ...current, imageLoaded: true }
                  : current,
              )
            }}
            onError={() => {
              setState(current =>
                current.status === 'ready' &&
                current.videoUrl === state.videoUrl
                  ? {
                      status: 'error',
                      message: 'Не удалось отобразить предпросмотр видео.',
                    }
                  : current,
              )
            }}
          />
        ) : null}
        {state.status === 'ready' && state.binaryKind === 'pdf' && state.binaryUrl ? (
          <iframe
            className="preview-frame"
            key={state.binaryUrl}
            src={state.binaryUrl}
            title={`Предпросмотр: ${current.name}`}
          />
        ) : null}
        {state.status === 'ready' && state.binaryKind === 'audio' && state.binaryUrl ? (
          <div className="preview-audio-wrap">
            <Icon name="file" width={48} height={48} />
            <audio className="preview-audio" controls key={state.binaryUrl} src={state.binaryUrl}>
              Ваш браузер не поддерживает воспроизведение аудио.
            </audio>
          </div>
        ) : null}
        {state.status === 'ready' && state.preview.type === 'unsupported' && !state.binaryUrl ? (
          <p className="empty-state preview-unsupported" role="status">Предпросмотр недоступен для этого типа файлов.</p>
        ) : null}
        </div>
      </div>
    </div>
  )
}

function detectBinaryKind(file: PreviewFile): 'pdf' | 'audio' | null {
  if (file.size === undefined) return null
  if (file.mimeType === 'application/pdf') return 'pdf'
  if (file.mimeType?.startsWith('audio/')) return 'audio'
  return null
}

function previewErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Не удалось загрузить предпросмотр. Попробуйте ещё раз.'
  const message = error.message.toLowerCase()
  if (error.kind === 'network') return 'Не удалось загрузить предпросмотр: сервер недоступен.'
  if (error.kind === 'authentication') return 'Сеанс завершён. Войдите снова.'
  if (error.kind === 'authorization') return 'У вас нет разрешения на просмотр этого файла.'
  if (error.status === 404) return 'Этот файл больше недоступен.'
  if (error.status === 400 && (message.includes('maximum preview size') || message.includes('exceeds'))) {
    return 'Файл слишком большой для предпросмотра.'
  }
  if (error.status === 400) return 'Предпросмотр этого файла недоступен.'
  if (error.kind === 'server') return 'Сервер не смог подготовить предпросмотр. Попробуйте ещё раз.'
  return 'Не удалось загрузить предпросмотр. Попробуйте ещё раз.'
}
