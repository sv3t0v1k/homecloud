import { useEffect, useRef, useState } from 'react'

import { ApiError } from '../api/errors'
import { useDialogFocus } from '../accessibility/useDialogFocus'
import type { FileItem } from '../types/files'
import { getFilePreview, previewImageBlob, previewVideoBlob, type PreviewPayload } from './preview'
import { Icon } from '../ui/Icon'
import { LiquidCloseButton } from '../ui/LiquidCloseButton'

type PreviewState =
  | { status: 'loading' }
  | {
      status: 'ready'
      preview: PreviewPayload
      imageUrl?: string
      videoUrl?: string
      imageLoaded?: boolean
    }
  | { status: 'error'; message: string }

export function PreviewModal({
  file,
  onClose,
}: {
  file: Pick<FileItem, 'id' | 'name'> &
    Partial<Pick<FileItem, 'mimeType'>>
  onClose(): void
}) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const closeButtonRef = useRef<HTMLButtonElement>(null)

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
  }, [file.id])

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

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    setState({ status: 'loading' })

    getFilePreview(file.id, controller.signal)
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

    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file.id])

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
          file.mimeType?.startsWith('image/') ||
          file.mimeType?.startsWith('video/') ||
          (state.status === 'ready' &&
            (state.preview.type === 'image' ||
              state.preview.type === 'video'))
            ? 'true'
            : undefined
        }
      >
        <div className="dialog-header">
          <h3 className="preview-title" id="preview-title">Просмотр: {file.name}</h3>
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
        {state.status === 'ready' && state.preview.type === 'text' ? (
          <pre className="preview-text mono">{state.preview.content}</pre>
        ) : null}
        {state.status === 'ready' && state.preview.type === 'image' && state.imageUrl ? (
          <img
            alt={`Предпросмотр: ${file.name}`}
            key={state.imageUrl}
            className="preview-image"
            src={state.imageUrl}
            data-image-pending={waitingForImage ? 'true' : undefined}
            onLoad={() => {
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
        ) : null}
        {state.status === 'ready' && state.preview.type === 'video' && state.videoUrl ? (
          <img
            alt={`Предпросмотр: ${file.name}`}
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
        {state.status === 'ready' && state.preview.type === 'unsupported' ? (
          <p className="empty-state preview-unsupported" role="status">Предпросмотр недоступен для этого типа файлов.</p>
        ) : null}
        </div>
      </div>
    </div>
  )
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
