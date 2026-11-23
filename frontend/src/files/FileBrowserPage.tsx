import { formatBytes } from '../ui/formatBytes'
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Icon } from '../ui/Icon'
import { LiquidCloseButton } from '../ui/LiquidCloseButton'
import { ActionMenu } from '../ui/ActionMenu'
import { useDialogFocus } from '../accessibility/useDialogFocus'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { ApiError } from '../api/errors'
import { apiRequest } from '../api/client'
import type { FileItem, FolderContents, FolderItem } from '../types/files'
import { copyFile, createFolder, getFolder, getFolderContents, moveFile, moveFolder, moveToTrash, renameFile, renameFolder, restoreTrashItem } from './api'
import { downloadOriginalFile, downloadSelectionArchive, type ArchiveSelection } from './download'
import { droppedEntries, inputEntries, pickDirectory } from '../sharing/publicTree'
import { enqueueTree } from './treeUpload'
import { UploadQueue, type UploadQueueItem } from './uploadQueue'
import {
  ShareDialog,
  type ShareDialogTarget,
} from '../sharing/ShareDialog'
import { PreviewModal } from './PreviewModal'
import { FileThumbnail } from './FileThumbnail'
import { safeOperationError } from './operationErrors'
import { locatedTarget, searchReturn } from './searchNavigation'
import { ToastProvider } from '../ui/toast'
import { useToast } from '../ui/toastContext'
import {
  fileTypeLabel,
  filterByName,
  readSavedSort,
  saveSort,
  sortFiles,
  sortFolders,
  toggleSort,
  type DirectorySort,
  type SortKey,
} from './directorySort'

interface Crumb { id: number; name: string }

type DirectoryDirection = 'enter' | 'back' | 'lateral'
type DirectoryMotionHistory = { current: string | null }

const DirectoryMotionContext =
  createContext<DirectoryMotionHistory | null>(null)

function directoryDirection(
  previous: string | null,
  next: string,
): DirectoryDirection | null {
  if (previous === null || previous === next) return null

  if (previous === '/' || next.startsWith(`${previous}/`)) {
    return 'enter'
  }

  if (next === '/' || previous.startsWith(`${next}/`)) {
    return 'back'
  }

  return 'lateral'
}
interface FolderLocationState { crumbs?: Crumb[] }

type PageState =
  | { status: 'loading' }
  | { status: 'ready'; folderId: number | null; contents: FolderContents; crumbs: Crumb[]; warning: string | null }
  | { status: 'error'; message: string }
  | { status: 'not-found' }
  | { status: 'forbidden' }

type RemovedItem = { kind: 'file' | 'folder'; id: number }

export function FileBrowserPage({ revision = 0 }: { revision?: number }) {
  const { folderId: folderIdParam } = useParams()
  const location = useLocation()
  const target = locatedTarget(location.state)
  const searchBack = searchReturn(location.state)
  const locatedKey = target ? `${target.kind}:${target.id}` : undefined
  const navigate = useNavigate()
  const [reloadKey, setReloadKey] = useState(0)
  const [page, setPage] = useState<PageState>({ status: 'loading' })
  const requestGeneration = useRef(0)
  const folderId = parseFolderId(folderIdParam)
  const providedQueue = useContext(UploadQueueContext)
  const sharedMotionHistory = useContext(DirectoryMotionContext)
  const localMotionHistory = useRef<string | null>(null)
  const motionHistory = sharedMotionHistory ?? localMotionHistory
  const [fallbackQueue] = useState(() => new UploadQueue(0, null))
  const queue = providedQueue ?? fallbackQueue
  const [dragging, setDragging] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const alive = useRef(true)
  const [collecting, setCollecting] = useState(false)
  const collectionLock = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => () => fallbackQueue.dispose(), [fallbackQueue])
  useEffect(() => {
    const preventNavigation = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault()
    }
    window.addEventListener('dragover', preventNavigation)
    window.addEventListener('drop', preventNavigation)
    return () => {
      window.removeEventListener('dragover', preventNavigation)
      window.removeEventListener('drop', preventNavigation)
    }
  }, [])

  useEffect(() => {
    if (folderIdParam !== undefined && folderId === null) {
      setPage({ status: 'error', message: 'Некорректный адрес папки.' })
      return
    }

    const controller = new AbortController()
    const generation = ++requestGeneration.current
    setPage((current) => current.status === 'ready' && current.folderId === folderId ? current : { status: 'loading' })
    loadPage(folderId, location.state, controller.signal)
      .then(({ contents, crumbs }) => {
        if (generation === requestGeneration.current && !controller.signal.aborted) setPage({ status: 'ready', folderId, contents, crumbs, warning: null })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return
        if (error instanceof ApiError && error.status === 404) {
          setPage({ status: 'not-found' })
          return
        }
        if (error instanceof ApiError && error.status === 403) {
          setPage({ status: 'forbidden' })
          return
        }
        const message = safeOperationError(error, 'Не удалось загрузить папку.')
        setPage((current) => current.status === 'ready' && current.folderId === folderId ? { ...current, warning: message } : { status: 'error', message })
      })
    return () => controller.abort()
  }, [folderId, folderIdParam, location.state, reloadKey, revision])

  const readyPage = page.status === 'ready' && page.folderId === folderId ? page : null
  const crumbs = readyPage ? readyPage.crumbs : readStateCrumbs(location.state)
  const title = crumbs[crumbs.length - 1]?.name ?? 'Мои файлы'

  function openFolder(folder: FolderItem) {
    navigate(`/files/folders/${folder.id}`, {
      state: { crumbs: [...crumbs, { id: folder.id, name: folder.name }] },
    })
  }

  function refresh(remove?: RemovedItem) {
    if (remove) {
      setPage((current) => current.status !== 'ready' || current.folderId !== folderId ? current : {
        ...current,
        contents: {
          files: remove.kind === 'file' ? current.contents.files.filter((item) => item.id !== remove.id) : current.contents.files,
          folders: remove.kind === 'folder' ? current.contents.folders.filter((item) => item.id !== remove.id) : current.contents.folders,
        },
      })
    }
    setReloadKey((key) => key + 1)
  }

  return (
    <ToastProvider>
    <section aria-labelledby="files-heading" className={`files-page${dragging ? ' files-page--drop' : ''}`}
      onDragEnter={(event) => { if (!Array.from(event.dataTransfer.types).includes('Files')) return; event.preventDefault(); dragDepth.current += 1; setDragging(true) }}
      onDragOver={(event) => { if (!Array.from(event.dataTransfer.types).includes('Files')) return; event.preventDefault(); event.dataTransfer.dropEffect = readyPage ? 'copy' : 'none' }}
      onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false) }}
      onDrop={(event) => {
        event.preventDefault(); dragDepth.current = 0; setDragging(false)
        if (!readyPage) { setDropError('Дождитесь загрузки папки и повторите перетаскивание.'); return }
        if (collectionLock.current) { setDropError('Дождитесь добавления предыдущей папки.'); return }
        collectionLock.current = true; setCollecting(true); setDropError(null)
        const target = folderId ?? undefined
        void droppedEntries(event.dataTransfer.items ?? [] as unknown as DataTransferItemList, event.dataTransfer.files)
          .then((entries) => enqueueTree(entries, queue, target, () => alive.current, () => { if (alive.current) setReloadKey((key) => key + 1) }))
          .catch((cause: unknown) => { if (alive.current) setDropError(cause instanceof Error && !(cause instanceof ApiError) ? cause.message : 'Не удалось добавить дерево папки. Уже добавленные объекты сохранены. Проверьте папку перед повтором.') })
          .finally(() => { collectionLock.current = false; if (alive.current) setCollecting(false) })
      }}>
      {dragging ? (
        <div
          className="upload-drop-status liquid-drop-surface"
          data-drop-ready={readyPage && !collecting
            ? 'true'
            : 'false'}
          role="status"
        >
          <div className="liquid-drop-message">
            <span
              className="liquid-drop-emblem"
              aria-hidden="true"
            >
              <Icon name="cloud" width={46} height={46} />
              <span className="liquid-drop-arrow">
                <Icon name="upload" width={18} height={18} />
              </span>
            </span>

            {readyPage && !collecting ? (
              <>
                <strong className="liquid-drop-title">
                  Отпустите файлы для загрузки
                </strong>

                <span className="liquid-drop-description">
                  Файлы будут добавлены в папку
                </span>

                <span className="liquid-drop-destination">
                  <Icon name="folder" />
                  <span>{title}</span>
                </span>

                <span className="liquid-drop-hint">
                  Можно перетаскивать файлы и целые папки
                </span>
              </>
            ) : (
              <>
                <strong className="liquid-drop-title">
                  {collecting
                    ? 'Добавляем предыдущие файлы'
                    : 'Папка пока недоступна для загрузки'}
                </strong>

                <span className="liquid-drop-description">
                  {collecting
                    ? 'Дождитесь завершения добавления.'
                    : 'Дождитесь загрузки папки и повторите попытку.'}
                </span>
              </>
            )}
          </div>
        </div>
      ) : null}
      {dropError ? <p className="inline-alert" role="alert">{dropError}</p> : null}
      {collecting ? <p role="status">Добавляем папки и файлы…</p> : null}
      <Breadcrumbs crumbs={crumbs} />
      {searchBack ? <div className="located-object-note"><Link className="text-link" to={searchBack}><Icon name="arrow-left" />Вернуться к результатам поиска</Link>{readyPage && target ? <span role="status">{(target.kind === 'file' ? readyPage.contents.files : readyPage.contents.folders).some(item => item.id === target.id) ? 'Найденный объект выделен в папке.' : 'Расположение изменилось или объект больше недоступен. Повторите поиск.'}</span> : null}</div> : null}
      <div className="files-page-header">
      <div className="page-heading"><h2 id="files-heading">{title}</h2></div>
      {folderIdParam === undefined || folderId !== null ? (
        <div className="files-toolbar">
          <UploadControl
            enabled={readyPage !== null}
            queue={queue}
            onUploaded={() => setReloadKey((key) => key + 1)}
            parentId={folderId ?? undefined}
          />
        </div>
      ) : null}
      </div>
      {page.status === 'loading' ? (
        <div aria-live="polite" className="directory-loading" role="status"><p className="sr-only">Загрузка файлов…</p>{[1, 2, 3, 4].map((row) => <div aria-hidden="true" className="skeleton-row" key={row}><span className="skeleton-icon" /><span className="skeleton-line" /><span className="skeleton-line skeleton-short" /></div>)}</div>
      ) : null}
      {page.status === 'error' ? (
        <div className="inline-alert directory-error" role="alert">
          <p className="error-text">{page.message}</p>
          <div className="state-actions">
            <button className="text-link" onClick={() => setReloadKey((key) => key + 1)} type="button">Повторить</button>
            <Link className="text-link" to="/files">К моим файлам</Link>
          </div>
        </div>
      ) : null}
      {page.status === 'not-found' ? (
        <DirectoryAccessState message="Папка не существует или недоступна." />
      ) : null}
      {page.status === 'forbidden' ? (
        <DirectoryAccessState message="У вас нет доступа к этой папке." />
      ) : null}
      {readyPage ? (
        <>{readyPage.warning ? <div className="inline-alert" role="alert">{readyPage.warning} <button className="text-link" onClick={() => setReloadKey((key) => key + 1)} type="button">Повторить</button></div> : null}<DirectoryTable key={`directory-${folderId}`} contents={readyPage.contents} currentFolderId={readyPage.folderId} onChanged={refresh} onOpenFolder={openFolder} locatedKey={locatedKey}
          motionHistory={motionHistory}
          motionPath={`/${readyPage.crumbs.map(crumb => crumb.id).join('/')}`}
        /></>
      ) : null}
      {!providedQueue ? <UploadManager queue={queue} /> : null}
    </section>
    </ToastProvider>
  )
}

function DirectoryAccessState({ message }: { message: string }) {
  return (
    <div className="empty-state" role="alert">
      <p className="muted">{message}</p>
      <Link className="text-link" to="/files">К моим файлам</Link>
    </div>
  )
}

async function loadPage(
  folderId: number | null,
  locationState: unknown,
  signal: AbortSignal,
) {
  if (folderId === null) {
    return { contents: await getFolderContents(undefined, signal), crumbs: [] }
  }
  const stateCrumbs = readStateCrumbs(locationState)
  let crumbs: Crumb[]
  if (stateCrumbs[stateCrumbs.length - 1]?.id === folderId) {
    const folder = await getFolder(folderId, signal)
    crumbs = [
      ...stateCrumbs.slice(0, -1),
      { id: folder.id, name: folder.name },
    ]
  } else {
    crumbs = await loadAncestors(folderId, signal)
  }
  return { contents: await getFolderContents(folderId, signal), crumbs }
}

async function loadAncestors(folderId: number, signal: AbortSignal): Promise<Crumb[]> {
  const reversed: Crumb[] = []
  const visited = new Set<number>()
  let currentId: number | null = folderId
  while (currentId !== null) {
    if (visited.has(currentId)) throw new Error('Folder ancestry contains a cycle')
    visited.add(currentId)
    const folder = await getFolder(currentId, signal)
    reversed.push({ id: folder.id, name: folder.name })
    currentId = folder.parentId
  }
  return reversed.reverse()
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  // Middle crumbs collapse into an ellipsis on narrow screens.
  const collapsible = crumbs.length > 2
  return (
    <nav aria-label="Путь к папке" className={`breadcrumbs${collapsible ? ' breadcrumbs--collapsible' : ''}`}>
      <ol className="breadcrumb-list">
        <li>{crumbs.length === 0 ? <span aria-current="page">Мои файлы</span> : <Link className="text-link" to="/files">Мои файлы</Link>}</li>
        {collapsible ? <li aria-hidden="true" className="breadcrumb-ellipsis">…</li> : null}
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1
          const middle = collapsible && index < crumbs.length - 1
          return (
            <li className={`breadcrumb-item${middle ? ' breadcrumb-item--middle' : ''}`} key={crumb.id}>
              <span aria-hidden="true">/</span>
              {current ? <span aria-current="page">{crumb.name}</span> : (
                <Link className="text-link" state={{ crumbs: crumbs.slice(0, index + 1) }} to={`/files/folders/${crumb.id}`}>{crumb.name}</Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

type ItemAction = { kind: 'file' | 'folder'; item: FileItem | FolderItem; action: 'rename' | 'move' | 'copy' | 'trash' }

function SortableTh({ column, label, sort, onSort }: { column: SortKey; label: string; sort: DirectorySort; onSort(key: SortKey): void }) {
  const active = sort.key === column
  return (
    <th aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined} scope="col">
      <button
        aria-label={`Сортировать: ${label}`}
        className={`column-sort${active ? ' is-active' : ''}`}
        onClick={() => onSort(column)}
        type="button"
      >
        <span>{label}</span>
        <Icon name={active ? (sort.direction === 'asc' ? 'sort-asc' : 'sort-desc') : 'sort'} />
      </button>
    </th>
  )
}

function DirectoryTable({
  contents, currentFolderId, onChanged, onOpenFolder,
  locatedKey, motionHistory, motionPath,
}: {
  contents: FolderContents
  currentFolderId: number | null
  onChanged(remove?: RemovedItem): void
  onOpenFolder(folder: FolderItem): void
  locatedKey?: string
  motionHistory: DirectoryMotionHistory
  motionPath: string
}) {
  const directoryRef = useRef<HTMLDivElement>(null)

  const motionDecision = useRef<{
    path: string
    direction: DirectoryDirection | null
  } | null>(null)

  useLayoutEffect(() => {
    if (motionDecision.current?.path !== motionPath) {
      motionDecision.current = {
        path: motionPath,
        direction: directoryDirection(
          motionHistory.current, motionPath,
        ),
      }
    }

    motionHistory.current = motionPath

    const element = directoryRef.current
    const direction = motionDecision.current.direction

    if (!element || !direction) return

    element.dataset.directoryMotion = direction

    const timer = window.setTimeout(() => {
      delete element.dataset.directoryMotion
    }, 1050)

    return () => {
      window.clearTimeout(timer)
      delete element.dataset.directoryMotion
    }
  }, [motionHistory, motionPath])

  const [shareTarget, setShareTarget] = useState<ShareDialogTarget | null>(null)
  const [action, setAction] = useState<ItemAction | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'list' | 'grid'>('list')
  const [viewMotion, setViewMotion] =
    useState<'list' | 'grid' | null>(null)

  type ViewTransitionHandle = {
    ready: Promise<void>
    finished: Promise<void>
    skipTransition(): void
  }

  type ViewRequest = {
    next: 'list' | 'grid'
    stop(): void
    dispose(): void
  }

  const viewTransitionRef =
    useRef<ViewRequest | null>(null)

  useEffect(() => {
    if (!viewMotion) return
    const timer = window.setTimeout(
      () => setViewMotion(null), 650,
    )
    return () => window.clearTimeout(timer)
  }, [viewMotion])

  useLayoutEffect(() => {
    return () => {
      const request = viewTransitionRef.current
      request?.stop()
      request?.dispose()
    }
  }, [])

  function changeView(next: 'list' | 'grid') {
    const previous = viewTransitionRef.current

    if (next === (previous?.next ?? view)) return

    // Do not queue visual transitions on rapid clicks.
    if (previous) {
      previous.stop()
      previous.dispose()
    }

    if (next === view) return

    const table = directoryRef.current
      ?.querySelector<HTMLTableElement>('.directory-list')

    const transitionDocument = document as unknown as {
      startViewTransition?: (
        update: () => void,
      ) => ViewTransitionHandle
    }

    const reducedMotion =
      window.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches ?? false

    if (
      !table ||
      reducedMotion ||
      !transitionDocument.startViewTransition
    ) {
      setView(next)
      setViewMotion(reducedMotion ? null : next)
      return
    }

    // A snapshot is visual only. The actual table remains
    // the same React component with the same state.
    table.dataset.viewCrossfade = 'true'

    let transition: ViewTransitionHandle | undefined

    const request: ViewRequest = {
      next,
      stop: () => transition?.skipTransition(),
      dispose: () => {
        if (viewTransitionRef.current !== request) return

        viewTransitionRef.current = null
        delete table.dataset.viewCrossfade

        document.removeEventListener(
          'pointerdown', interrupt, true,
        )
        document.removeEventListener(
          'keydown', interrupt, true,
        )
      },
    }

    function interrupt() {
      // Input should never have to wait for the animation.
      request.stop()
    }

    viewTransitionRef.current = request

    try {
      transition = transitionDocument.startViewTransition(
        () => {
          if (viewTransitionRef.current !== request) return

          flushSync(() => {
            setViewMotion(null)
            setView(next)
          })
        },
      )

      document.addEventListener(
        'pointerdown', interrupt, true,
      )
      document.addEventListener(
        'keydown', interrupt, true,
      )

      // Aborted animations must not leave stale styles.
      void transition.ready.catch(() => undefined)

      void transition.finished.then(
        request.dispose,
        request.dispose,
      )
    } catch {
      request.dispose()
      setView(next)
      setViewMotion(next)
    }
  }
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [archivePending, setArchivePending] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const archivePendingRef = useRef(false)
  const toast = useToast()
  useEffect(() => {
    if (!locatedKey) return
    const exists = [...contents.files.map(item => `file:${item.id}`), ...contents.folders.map(item => `folder:${item.id}`)].includes(locatedKey)
    if (!exists) return
    setSelection(new Set([locatedKey]))
    const row = document.querySelector<HTMLElement>(`[data-object-key="${locatedKey}"]`)
    row?.scrollIntoView?.({ block: 'center' })
    row?.querySelector<HTMLButtonElement>('.file-name')?.focus({ preventScroll: true })
  }, [locatedKey, contents])
  useEffect(() => {
    const valid = new Set([...contents.folders.map((item) => `folder:${item.id}`), ...contents.files.map((item) => `file:${item.id}`)])
    setSelection((previous) => new Set([...previous].filter((key) => valid.has(key))))
  }, [contents])
  const anchor = useRef<string>()
  const selectionDockRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!selection.size) return

    function clearSelectionOnBackground(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        !(event.target instanceof HTMLElement) ||
        document.querySelector('[aria-modal="true"]')
      ) return

      const target = event.target
      const page = selectionDockRef.current?.closest('.files-page')

      if (!page) return

      const workspace = page.closest('.workspace')
      const frame = page.closest('.app-frame')
      const table = page.querySelector<HTMLTableElement>(
        '.directory-list',
      )

      // Only actual background surfaces, never file rows,
      // menus, controls, breadcrumbs or upload panels.
      const isBackground =
        target === page ||
        target === workspace ||
        target === frame ||
        target === table ||
        target === table?.parentElement ||
        target === table?.tBodies[0]

      if (!isBackground) return

      anchor.current = undefined
      setSelection(new Set())
    }

    document.addEventListener(
      'click', clearSelectionOnBackground, true,
    )

    return () => document.removeEventListener(
      'click', clearSelectionOnBackground, true,
    )
  }, [selection.size])
  const [sort, setSort] = useState<DirectorySort>(() => readSavedSort(typeof sessionStorage === 'undefined' ? undefined : sessionStorage))
  const [filter, setFilter] = useState('')
  function changeSort(key: SortKey) {
    setSort((current) => {
      const next = toggleSort(current, key)
      saveSort(next, typeof sessionStorage === 'undefined' ? undefined : sessionStorage)
      return next
    })
  }
  const folders = useMemo(
    () => sortFolders(filterByName(contents.folders, filter), sort),
    [contents.folders, filter, sort],
  )
  const files = useMemo(
    () => sortFiles(filterByName(contents.files, filter), sort),
    [contents.files, filter, sort],
  )
  const filtering = filter.trim().length > 0
  const visibleKeys = [...folders.map((item) => `folder:${item.id}`), ...files.map((item) => `file:${item.id}`)]
  function select(key: string, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }, toggle = false) {
    setSelection((previous) => {
      if (event.shiftKey && anchor.current && visibleKeys.includes(anchor.current)) {
        const indices = [visibleKeys.indexOf(anchor.current), visibleKeys.indexOf(key)].sort((a, b) => a - b)
        return new Set([...previous, ...visibleKeys.slice(indices[0], indices[1] + 1)])
      }
      anchor.current = key
      if (toggle || event.metaKey || event.ctrlKey) { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next }
      return new Set([key])
    })
  }
  function contextMenu(event: React.MouseEvent<HTMLTableRowElement>, key: string) {
    if ((event.target as HTMLElement).closest('.file-actions, input, label')) return
    event.preventDefault()
    if (!selection.has(key)) setSelection(new Set([key]))
    event.currentTarget.querySelector<HTMLButtonElement>('.action-menu > button')?.click()
  }
  async function downloadArchive() {
    if (archivePendingRef.current || selection.size < 2) return
    archivePendingRef.current = true
    setArchivePending(true)
    setArchiveError(null)
    toast.dismissKey('archive-download')
    const items: ArchiveSelection[] = [...selection].map((key) => {
      const [kind, id] = key.split(':')
      return { kind: kind as ArchiveSelection['kind'], id: Number(id) }
    })
    try {
      await downloadSelectionArchive(items)
      if (mounted.current) toast.notify({ kind: 'success', key: 'archive-download', message: 'ZIP передан браузеру. Состояние смотрите в его загрузках.' })
    } catch (cause) {
      if (mounted.current) setArchiveError(archiveDownloadErrorMessage(cause))
    } finally {
      archivePendingRef.current = false
      if (mounted.current) setArchivePending(false)
    }
  }
  async function restoreFromTrash(targets: Array<{ kind: 'file' | 'folder'; id: number }>) {
    try {
      for (const target of targets) {
        await restoreTrashItem(target.kind, target.id)
        if (!mounted.current) return
      }
      onChanged()
    } catch {
      if (mounted.current) toast.notify({ kind: 'error', message: 'Не удалось отменить перемещение в корзину. Проверьте корзину.' })
    }
  }
  async function trashSelection() {
    if (pendingRef.current) return
    pendingRef.current = true; setPending(true); setBulkError(null)
    const targets = [...selection]
    const trashed: Array<{ kind: 'file' | 'folder'; id: number }> = []
    try {
      for (const key of targets) {
        const [kind, id] = key.split(':')
        await moveToTrash(kind as 'file' | 'folder', Number(id))
        if (!mounted.current) return
        trashed.push({ kind: kind as 'file' | 'folder', id: Number(id) })
        setSelection((previous) => { const next = new Set(previous); next.delete(key); return next })
        onChanged({ kind: kind as 'file' | 'folder', id: Number(id) })
      }
      setBulkOpen(false)
      toast.notify({
        message: `Перемещено в корзину: ${trashed.length}`,
        actionLabel: 'Отменить',
        key: 'bulk-trash',
        onAction: () => void restoreFromTrash(trashed),
      })
    } catch (cause) { if (mounted.current) setBulkError(safeOperationError(cause, 'Не удалось переместить все объекты в корзину. Уже обработанные объекты сохранены.')) }
    finally { pendingRef.current = false; if (mounted.current) setPending(false) }
  }
  const pendingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  function openAction(next: ItemAction) { setError(null); setAction(next) }

  async function mutate(name: string, destination: string) {
    if (!action || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    const { kind, item, action: operation } = action
    const parent = destination === '' ? undefined : Number(destination)
    try {
      if (operation === 'rename') await (kind === 'file' ? renameFile(item.id, name) : renameFolder(item.id, name))
      if (operation === 'move') await (kind === 'file' ? moveFile(item.id, parent) : moveFolder(item.id, parent ?? null))
      if (operation === 'copy') await copyFile(item.id, parent)
      if (operation === 'trash') await moveToTrash(kind, item.id)
      if (!mounted.current) return
      setAction(null)
      onChanged(operation === 'trash' ? { kind, id: item.id } : undefined)
      if (operation === 'trash') {
        toast.notify({
          message: kind === 'folder' ? 'Папка перемещена в корзину' : 'Файл перемещён в корзину',
          actionLabel: 'Отменить',
          key: `trash-${kind}-${item.id}`,
          onAction: () => void restoreFromTrash([{ kind, id: item.id }]),
        })
      }
    } catch (caught) {
      if (mounted.current) setError(safeOperationError(caught, 'Не удалось выполнить действие.'))
    } finally {
      pendingRef.current = false
      if (mounted.current) setPending(false)
    }
  }

  const empty = folders.length === 0 && files.length === 0
  const trulyEmpty = contents.folders.length === 0 && contents.files.length === 0
  return (
    <div ref={directoryRef}>
      <div className="directory-controls">
        <div className="directory-toolbar"><p className="muted">Папок: {contents.folders.length} · Файлов: {contents.files.length}{filtering ? ` · По фильтру: ${folders.length + files.length}` : ''}</p><div className="directory-tools"><label className="directory-filter"><Icon name="search" /><input aria-label="Фильтр по имени в этой папке" className="directory-filter-input" onChange={(event) => setFilter(event.target.value)} placeholder="Фильтр по имени" type="search" value={filter} />{filtering ? <button aria-label="Очистить фильтр" className="icon-button directory-filter-clear" onClick={() => setFilter('')} type="button"><Icon name="close" /></button> : null}</label><div className="view-switch" aria-label="Вид файлов"><button aria-label="Список" aria-pressed={view === 'list'} className={view === 'list' ? 'icon-button is-active' : 'icon-button'} onClick={() => changeView('list')} type="button"><Icon name="list" /></button><button aria-label="Плитка" aria-pressed={view === 'grid'} className={view === 'grid' ? 'icon-button is-active' : 'icon-button'} onClick={() => changeView('grid')} type="button"><Icon name="grid" /></button></div></div></div>
      </div>
      {selection.size ? <><div
        className="selection-toolbar liquid-selection-dock"
        ref={selectionDockRef}
        role="region"
        aria-label="Выделенные объекты"
      >
        <div className="selection-dock-count">
          <span className="sr-only">
            Выбрано: {selection.size}
          </span>

          <span
            aria-hidden="true"
            className="selection-dock-number"
          >
            {selection.size}
          </span>

          <span
            aria-hidden="true"
            className="selection-dock-caption"
          >
            Выбрано
          </span>
        </div>

        <span
          aria-hidden="true"
          className="selection-dock-divider"
        />

        <button
          aria-label="Выбрать всё"
          className="icon-button selection-dock-action"
          onClick={() => setSelection(new Set(visibleKeys))}
          type="button"
        >
          <Icon name="check" />
          <span
            className="selection-dock-label"
            aria-hidden="true"
          >
            Выбрать всё
          </span>
        </button>

        {selection.size >= 2 ? (
          <button
            aria-label={archivePending
              ? 'Подготавливаем ZIP…'
              : 'Скачать ZIP'}
            className="icon-button selection-dock-action"
            disabled={archivePending || pending}
            onClick={() => void downloadArchive()}
            type="button"
          >
            <Icon name="download" />
            <span
              aria-hidden="true"
              className="selection-dock-label"
            >
              {archivePending
                ? 'Подготавливаем ZIP…'
                : 'Скачать ZIP'}
            </span>
          </button>
        ) : null}

        <button
          aria-label="В корзину"
          className="icon-button selection-dock-action selection-dock-trash"
          disabled={pending || archivePending}
          onClick={(event) => {
            event.currentTarget.focus()
            setBulkError(null)
            setBulkOpen(true)
          }}
          type="button"
        >
          <Icon name="trash" />
          <span
            className="selection-dock-label"
            aria-hidden="true"
          >
            В корзину
          </span>
        </button>

        <span
          aria-hidden="true"
          className="selection-dock-divider"
        />

        <button
          aria-label="Снять выделение"
          className="icon-button selection-dock-action selection-dock-clear"
          onClick={() => {
            anchor.current = undefined
            setSelection(new Set())
          }}
          type="button"
        >
          <Icon name="close" />
          <span
            className="selection-dock-label"
            aria-hidden="true"
          >
            Снять выделение
          </span>
        </button>
      </div>{archiveError ? <p className="inline-alert" role="alert">{archiveError}</p> : null}</> : null}
      {bulkOpen ? <SmallDialog title="Переместить выбранное в корзину?" onClose={() => { if (!pending) setBulkOpen(false) }}><p>Объектов: {selection.size}. Их можно будет восстановить.</p>{bulkError ? <p role="alert">{bulkError}</p> : null}<div className="dialog-actions"><button className="button button--ghost" disabled={pending} onClick={() => setBulkOpen(false)} type="button">Отмена</button><button className="button button--danger" disabled={pending} onClick={() => void trashSelection()} type="button">{pending ? 'Выполняется…' : 'Переместить выбранное'}</button></div></SmallDialog> : null}
      {trulyEmpty ? <div className="empty-state"><Icon name="folder" /><h3>В этой папке пока пусто</h3><p>Перетащите файлы сюда или воспользуйтесь кнопкой «Добавить».</p></div> : empty ? (
        <div className="empty-state" role="status"><Icon name="search" /><h3>По фильтру ничего не найдено</h3><p>В этой папке нет имён, содержащих «{filter.trim()}».</p><button className="text-link" onClick={() => setFilter('')} type="button">Сбросить фильтр</button></div>
      ) : (
        <table
          className={view === 'grid' ? 'directory-list directory-grid' : 'directory-list'}
          data-view-motion={viewMotion ?? undefined}
          onPointerDownCapture={() => setViewMotion(null)}
          onFocusCapture={() => setViewMotion(null)}
        >
          <caption className="sr-only">Файлы и папки в текущем расположении</caption>
          <thead className="directory-header"><tr>
            <SortableTh column="name" label="Название" onSort={changeSort} sort={sort} />
            <SortableTh column="type" label="Тип" onSort={changeSort} sort={sort} />
            <SortableTh column="size" label="Размер" onSort={changeSort} sort={sort} />
            <SortableTh column="updatedAt" label="Изменено" onSort={changeSort} sort={sort} />
            <th scope="col"><span className="sr-only">Действия</span></th>
          </tr></thead>
          <tbody>
            {folders.map((folder) => <tr data-object-key={`folder:${folder.id}`} className={`directory-row${selection.has(`folder:${folder.id}`) ? ' is-selected' : ''}${locatedKey === `folder:${folder.id}` ? ' is-located' : ''}`} key={`folder-${folder.id}`} onContextMenu={(event) => contextMenu(event, `folder:${folder.id}`)} onClick={(event) => { if (!(event.target as HTMLElement).closest('.file-actions, input, label')) select(`folder:${folder.id}`, event) }}>
              <td className="file-name-cell"><label className="selection-hit"><input aria-label={`Выбрать ${folder.name}`} type="checkbox" checked={selection.has(`folder:${folder.id}`)} onChange={() => {}} onClick={(event) => select(`folder:${folder.id}`, event, true)} /></label><span className="file-icon file-icon-folder"><Icon name="folder" /></span><button className="file-name" onDoubleClick={() => onOpenFolder(folder)} onKeyDown={(event) => { if (event.key === "Enter") onOpenFolder(folder) }} type="button">{folder.name}</button></td>
              <td className="file-meta"><span className="mobile-label">Тип: </span>Папка</td><td className="file-meta"><span className="mobile-label">Размер: </span>—</td><td className="file-meta"><span className="mobile-label">Изменено: </span>{formatDate(folder.updatedAt)}</td>
              <td className="file-actions"><ActionMenu label={`Действия: ${folder.name}`} disabled={pending} items={[
                { label: 'Открыть', icon: 'folder', onSelect: () => onOpenFolder(folder) },
                { label: 'Поделиться', icon: 'link', onSelect: () => setShareTarget({ fileId: folder.shareFileId, name: folder.name, isFolder: true }) },
                { label: 'Переименовать', icon: 'edit', onSelect: () => openAction({ kind: 'folder', item: folder, action: 'rename' }) },
                { label: 'Переместить', icon: 'move', onSelect: () => openAction({ kind: 'folder', item: folder, action: 'move' }) },
                { label: 'В корзину', icon: 'trash', danger: true, onSelect: () => openAction({ kind: 'folder', item: folder, action: 'trash' }) },
              ]} /></td>
            </tr>)}
            {files.map((file) => <FileRow selected={selection.has(`file:${file.id}`)} onSelect={(event, toggle) => select(`file:${file.id}`, event, toggle)} onContextMenu={(event) => contextMenu(event, `file:${file.id}`)} disabled={pending} file={file} key={`file-${file.id}`} onAction={(operation) => openAction({ kind: 'file', item: file, action: operation })} onDownloadStarted={() => toast.dismissKey('file-download')} onDownloadHandedOff={() => toast.notify({ kind: 'success', key: 'file-download', message: 'Скачивание передано браузеру. Состояние смотрите в его загрузках.' })} onShare={() => setShareTarget({
      fileId: file.id,
      name: file.name,
      isFolder: false,
      mimeType: file.mimeType,
      updatedAt: file.updatedAt,
    })} />)}
          </tbody>
        </table>
      )}
      {!action && pending ? <p className="muted" role="status">Операция продолжается…</p> : null}
      {!action && error ? <p className="inline-alert" role="alert">{error}</p> : null}
      {shareTarget ? <ShareDialog onClose={() => setShareTarget(null)} target={shareTarget} /> : null}
      {action ? <OperationDialog action={action} busy={pending} currentFolderId={currentFolderId} error={error} onClose={() => { setAction(null); setError(null) }} onSubmit={mutate} /> : null}
    </div>
  )
}

function FileRow({ disabled, file, onAction, onDownloadStarted, onDownloadHandedOff, onShare, selected, onSelect, onContextMenu }: { selected: boolean; onSelect(event: React.MouseEvent, toggle?: boolean): void; onContextMenu(event: React.MouseEvent<HTMLTableRowElement>): void; disabled: boolean; file: FileItem; onAction(action: ItemAction['action']): void; onDownloadStarted(): void; onDownloadHandedOff(): void; onShare(): void }) {
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading' | 'handed-off'>('idle')
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const downloadPending = useRef(false)
  async function download() {
    if (downloadPending.current) return
    downloadPending.current = true
    onDownloadStarted()
    setDownloadState('downloading')
    setDownloadError(null)
    try { await downloadOriginalFile(file); setDownloadState('handed-off'); onDownloadHandedOff() }
    catch (error) { setDownloadError(downloadErrorMessage(error)); setDownloadState('idle') }
    finally { downloadPending.current = false }
  }
  const fileType = file.mimeType?.startsWith('image/') ? 'image' : file.mimeType?.startsWith('text/') ? 'text' : 'file'
  return <tr data-object-key={`file:${file.id}`} className={`directory-row${selected ? ' is-selected' : ''}`} onContextMenu={onContextMenu} onClick={(event) => { if (!(event.target as HTMLElement).closest('.file-actions, input, label')) onSelect(event) }}>
    <td className="file-name-cell"><label className="selection-hit"><input aria-label={`Выбрать ${file.name}`} type="checkbox" checked={selected} onChange={() => {}} onClick={(event) => onSelect(event, true)} /></label>{['image/jpeg', 'image/png', 'image/webp'].includes(file.mimeType ?? '') ? <FileThumbnail key={`${file.id}:${file.updatedAt}`} fileId={file.id} /> : <span className={`file-icon file-icon-${fileType}`}><Icon name={fileType} /></span>}<button className="file-name" onDoubleClick={(event) => { event.currentTarget.focus(); setShowPreview(true) }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setShowPreview(true) } }} title={file.name} type="button">{file.name}</button></td>
    <td className="file-meta"><span className="mobile-label">Тип: </span>{fileTypeLabel(file.mimeType)}</td>
    <td className="file-meta"><span className="mobile-label">Размер: </span>{formatBytes(file.size)}</td>
    <td className="file-meta"><span className="mobile-label">Изменено: </span>{formatDate(file.updatedAt)}</td>
    <td className="file-actions"><ActionMenu label={`Действия: ${file.name}`} disabled={disabled} items={[
      { label: 'Просмотр', icon: 'file', onSelect: () => setShowPreview(true) },
      { label: downloadState === 'downloading' ? 'Подготавливаем…' : 'Скачать', icon: 'download', disabled: downloadState === 'downloading', onSelect: () => void download() },
      { label: 'Поделиться', icon: 'link', onSelect: onShare },
      { label: 'Переименовать', icon: 'edit', onSelect: () => onAction('rename') },
      { label: 'Переместить', icon: 'move', onSelect: () => onAction('move') },
      { label: 'Копировать', icon: 'copy', onSelect: () => onAction('copy') },
      { label: 'В корзину', icon: 'trash', danger: true, onSelect: () => onAction('trash') },
    ]} />
    {downloadError ? <p className="inline-alert" role="alert">{downloadError}</p> : null}
    {showPreview ? (
      <PreviewModal
        file={file}
        onClose={() => setShowPreview(false)}
      />
    ) : null}</td>
  </tr>
}

function SmallDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  const ref = useDialogFocus(onClose)
  return (
    <div className="dialog-overlay liquid-operation-overlay">
      <div
        aria-labelledby="file-operation-title"
        aria-modal="true"
        className="dialog-surface liquid-operation-dialog"
        ref={ref}
        role="dialog"
        tabIndex={-1}
      >
        <div className="dialog-header">
          <h3 id="file-operation-title">{title}</h3>
          <LiquidCloseButton
            aria-label="Закрыть"
            onClick={onClose}
          />
        </div>
        {children}
      </div>
    </div>
  )
}

function OperationDialog({ action, busy, currentFolderId, error, onClose, onSubmit }: { action: ItemAction; busy: boolean; currentFolderId: number | null; error: string | null; onClose(): void; onSubmit(name: string, destination: string): Promise<void> }) {
  const [name, setName] = useState(action.item.name)
  const [destination, setDestination] = useState(action.action === 'copy' ? String(currentFolderId ?? '') : '')
  const [validation, setValidation] = useState<string | null>(null)
  const [destinations, setDestinations] = useState<Array<{ id: number; name: string }>>([])
  const [destinationLoading, setDestinationLoading] = useState(true)
  const [destinationError, setDestinationError] = useState<string | null>(null)
  const [destinationReload, setDestinationReload] = useState(0)
  useEffect(() => {
    if (action.action !== 'move' && action.action !== 'copy') return
    const controller = new AbortController()
    setDestinationLoading(true)
    setDestinationError(null)
    async function load() {
      const options: Array<{ id: number; name: string }> = []
      const visited = new Set<number>()
      async function walk(parentId?: number, prefix = '') {
        const folders = await apiRequest<FolderItem[]>({ method: 'GET', url: '/files/folders', params: parentId === undefined ? undefined : { parentId }, signal: controller.signal })
        for (const folder of folders) {
          if (visited.has(folder.id)) continue
          visited.add(folder.id)
          // Do not offer the moved folder or any part of its subtree.
          if (action.kind === 'folder' && folder.id === action.item.id) continue
          const name = prefix ? `${prefix} / ${folder.name}` : folder.name
          options.push({ id: folder.id, name })
          await walk(folder.id, name)
        }
      }
      await walk()
      if (!controller.signal.aborted) setDestinations(options)
    }
    void load().catch((cause: unknown) => {
      if (!controller.signal.aborted) setDestinationError(safeOperationError(cause, 'Не удалось загрузить папки назначения.'))
    }).finally(() => { if (!controller.signal.aborted) setDestinationLoading(false) })
    return () => controller.abort()
  }, [action.action, action.kind, action.item.id, destinationReload])
  const titles = { rename: 'Переименовать', move: 'Переместить', copy: 'Копировать', trash: 'Переместить в корзину' }
  const selecting = action.action === 'move' || action.action === 'copy'
  return <SmallDialog title={titles[action.action]} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); if (busy || (selecting && (destinationLoading || destinationError))) return; if (action.action === 'rename' && (!name.trim() || name.trim().length > 255)) { setValidation('Введите название от 1 до 255 символов.'); return } setValidation(null); void onSubmit(name.trim(), destination) }}>
    <p className="muted dialog-item-name">{action.item.name}</p>
    {action.action === 'rename' ? <label className="field">Новое название<input className="input" disabled={busy} maxLength={255} onChange={(event) => { setName(event.target.value); setValidation(null) }} value={name} /></label> : null}
    {selecting ? <label className="field">Папка назначения<select className="input" disabled={busy || destinationLoading || destinationError !== null} onChange={(event) => setDestination(event.target.value)} value={destination}><option value="">Мои файлы</option>{destinations.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label> : null}
    {selecting && destinationLoading ? <p role="status">Загружаем папки назначения…</p> : null}
    {selecting && destinationError ? <p className="inline-alert" role="alert">{destinationError} <button className="text-link" onClick={() => setDestinationReload((value) => value + 1)} type="button">Повторить</button></p> : null}
    {action.action === 'trash' ? <p>{action.kind === 'folder' ? 'Папка и её содержимое попадут в корзину.' : 'Файл попадёт в корзину.'} Вы сможете восстановить их позже.</p> : null}
    {validation || error ? <p className="inline-alert" role="alert">{validation || error}</p> : null}
    <div className="dialog-actions"><button className="button button--ghost" onClick={onClose} type="button">{busy ? 'Закрыть' : 'Отмена'}</button><button className={action.action === 'trash' ? 'button button--danger' : 'button button--primary'} disabled={busy || (selecting && (destinationLoading || destinationError !== null))} type="submit">{busy ? 'Выполняется…' : titles[action.action]}</button></div>
  </form></SmallDialog>
}

function CreateFolderControl({ enabled, parentId, onCreated, open, setOpen, onBusyChange }: { onBusyChange(value: boolean): void; enabled: boolean; parentId?: number; onCreated(): void; open: boolean; setOpen(value: boolean): void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (busyRef.current || !enabled) return
    if (!trimmed || trimmed.length > 255) { setError('Введите название от 1 до 255 символов.'); return }
    busyRef.current = true
    onBusyChange(true)
    setBusy(true)
    setError(null)
    try { await createFolder(trimmed, parentId); if (mounted.current) { setName(''); setOpen(false); onCreated() } }
    catch (caught) { if (mounted.current) setError(safeOperationError(caught, 'Не удалось создать папку.')) }
    finally { busyRef.current = false; onBusyChange(false); if (mounted.current) setBusy(false) }
  }
  function close() { setOpen(false); setError(null) }
  return <>{open ? <SmallDialog onClose={close} title="Новая папка"><form onSubmit={(event) => void submit(event)}><label className="field" htmlFor="new-folder-name">Название папки</label><input className="input" disabled={busy} id="new-folder-name" maxLength={255} onChange={(event) => setName(event.target.value)} placeholder="Например, Документы" value={name} />{error ? <p className="inline-alert" role="alert">{error}</p> : null}<div className="dialog-actions"><button className="button button--ghost" onClick={close} type="button">{busy ? 'Закрыть' : 'Отмена'}</button><button className="button button--primary" disabled={busy || !name.trim()} type="submit">{busy ? 'Создание…' : 'Создать папку'}</button></div></form></SmallDialog> : null}{!open && busy ? <p className="muted" role="status">Создание папки продолжается…</p> : null}{!open && error ? <p className="inline-alert" role="alert">{error}</p> : null}</>
}

const UploadQueueContext = createContext<UploadQueue | null>(null)

export function UploadQueueProvider({ ownerId, children }: { ownerId: number; children: ReactNode }) {
  const [queue] = useState(() => new UploadQueue(ownerId))
  const motionHistory = useRef<string | null>(null)
  const [discoveryError, setDiscoveryError] = useState(false)
  useEffect(() => {
    void queue.discover().catch(() => setDiscoveryError(true))
    return () => queue.dispose()
  }, [queue])
  return <DirectoryMotionContext.Provider value={motionHistory}>
    <UploadQueueContext.Provider value={queue}>{discoveryError ? <p className="inline-alert" role="alert">Не удалось проверить незавершённые загрузки. <button className="text-link" onClick={() => { void queue.discover().then(() => setDiscoveryError(false)).catch(() => setDiscoveryError(true)) }} type="button">Проверить снова</button></p> : null}{children}<UploadManager queue={queue} /></UploadQueueContext.Provider>
    </DirectoryMotionContext.Provider>
}

function UploadControl({ enabled, parentId, onUploaded, queue }: { enabled: boolean; parentId?: number; onUploaded(): void; queue: UploadQueue }) {
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot)
  const [createOpen, setCreateOpen] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  useEffect(() => setCreateOpen(false), [parentId])
  const [collecting, setCollecting] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  const busy = useRef(false)
  const alive = useRef(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const knownCompleted = useRef(new Set<string>())
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let changed = false
    for (const item of items) if (item.state === 'completed' && !knownCompleted.current.has(item.id)) { knownCompleted.current.add(item.id); changed = true }
    if (changed) onUploaded()
  }, [items, onUploaded])
  async function add(entries: Parameters<typeof enqueueTree>[0], target = parentId) {
    if (busy.current || !enabled) return
    busy.current = true; setCollecting(true); setTreeError(null)
    try { await enqueueTree(entries, queue, target, () => alive.current, onUploaded) }
    catch (cause) { if (alive.current) setTreeError(cause instanceof Error && !(cause instanceof ApiError) ? cause.message : 'Не удалось добавить папку. Уже добавленные объекты сохранены. Проверьте результат перед повтором.') }
    finally { busy.current = false; if (alive.current) setCollecting(false) }
  }
  async function chooseFolder() {
    const target = parentId
    try {
      const entries = await pickDirectory()
      if (!alive.current) return
      if (entries) await add(entries, target)
      else folderRef.current?.click()
    } catch (cause) {
      if ((cause as { name?: string }).name !== 'AbortError') setTreeError('Не удалось прочитать папку. Повторите выбор или перетащите её в окно.')
    }
  }
  return <section aria-label="Добавление и загрузки" className="upload-control">
    <ActionMenu label="Добавить" triggerLabel="Добавить" disabled={!enabled || collecting} items={[
      { label: 'Загрузить файлы', icon: 'upload', onSelect: () => inputRef.current?.click() },
      { label: 'Загрузить папку', icon: 'folder', onSelect: () => void chooseFolder() },
      { label: 'Новая папка', icon: 'plus', disabled: createBusy, onSelect: () => setCreateOpen(true) },
    ]} />
    <input ref={inputRef} aria-label="Выбрать файл для загрузки" className="sr-only upload-input" disabled={!enabled || collecting} multiple type="file"
      onChange={(event) => { try { void add(inputEntries(event.target.files ?? [])) } catch (cause) { setTreeError(cause instanceof Error ? cause.message : 'Не удалось прочитать файлы.') } event.target.value = '' }} />
    <input ref={folderRef} aria-label="Выбрать папку для загрузки" className="sr-only upload-input" disabled={!enabled || collecting} multiple type="file" {...{ webkitdirectory: '', directory: '' }}
      onChange={(event) => { try { void add(inputEntries(event.target.files ?? [])) } catch (cause) { setTreeError(cause instanceof Error ? cause.message : 'Не удалось прочитать папку.') } event.target.value = '' }} />
    <CreateFolderControl key={`create-${parentId}`} enabled={enabled} parentId={parentId} onCreated={onUploaded} open={createOpen} setOpen={setCreateOpen} onBusyChange={setCreateBusy} />
    {collecting ? <p role="status">Добавляем папки и файлы…</p> : null}
    {treeError ? <p className="inline-alert" role="alert">{treeError}</p> : null}

  </section>
}

function UploadManager({ queue }: { queue: UploadQueue }) {
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot)
  const [collapsed, setCollapsed] = useState(false)
  const problems = items.filter((item) => item.state === 'error' || item.needsFile).length
  const completedCount = items.filter(
    item => item.state === 'completed',
  ).length

  const allCompleted = items.length > 0 &&
    completedCount === items.length
  return <>
    {items.length ? <div
      className="upload-manager liquid-upload-dock"
      aria-label="Загрузки"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-completed={allCompleted ? 'true' : 'false'}
    >
      <div className="upload-manager-header">
        <button
          className="button button--ghost upload-summary"
          aria-expanded={!collapsed}
          aria-controls="upload-list"
          aria-label={`Загрузки · ${completedCount}/${items.length}${problems ? ` · Требуют внимания: ${problems}` : ''} · ${collapsed ? 'Развернуть' : 'Свернуть'}`}
          onClick={() => setCollapsed(value => !value)}
          type="button"
        >
          <span className="upload-dock-mark">
            <Icon name="upload" />
          </span>

          <span className="upload-dock-heading">
            <strong>Загрузки</strong>
            <span className="upload-dock-subtitle">
              {allCompleted
                ? 'Все файлы загружены'
                : `${completedCount} из ${items.length} файлов`}
            </span>
            {problems ? (
              <span className="upload-dock-warning">
                Требуют внимания: {problems}
              </span>
            ) : null}
          </span>

          <span className="upload-dock-chevron">
            <Icon name="chevron" />
          </span>
        </button>

        {allCompleted ? (
          <div className="upload-dismiss-slot">
            <LiquidCloseButton
              aria-label="Закрыть"
              className="upload-dismiss"
              onClick={() => queue.dismissCompleted()}
            />
          </div>
        ) : null}
      </div>
      <div id="upload-list" hidden={collapsed}>
      <ul className="upload-queue">{items.map((item) => <UploadRow key={item.id} item={item} queue={queue} />)}</ul>
      </div>
    </div> : null}
  </>
}

const uploadStateLabels: Record<UploadQueueItem['state'], string> = {
  selected: 'Ожидает запуска', queued: 'В очереди', preparing: 'Подготовка загрузки…', hashing: 'Вычисление SHA-256…', uploading: 'Загрузка…',
  pausing: 'Приостанавливаем после текущей части…', paused: 'Приостановлено', retrying: 'Ожидание повторной попытки…',
  completing: 'Финализация файла на HDD…', completed: 'Файл загружен', error: 'Требуется действие', cancelling: 'Отменяем загрузку…',
  cancelled: 'Загрузка отменена.', 'needs-file': 'Для докачки выберите исходный файл',
}

function UploadRow({ item, queue }: { item: UploadQueueItem; queue: UploadQueue }) {
  const canPause = ['queued', 'preparing', 'hashing', 'uploading', 'retrying'].includes(item.state)
  const canResume = ['paused', 'error'].includes(item.state) && !item.needsFile
  const canCancel = !['completed', 'cancelled', 'cancelling', 'completing'].includes(item.state)
  const [reselectionError, setReselectionError] = useState<string | null>(null)

  const completed = item.state === 'completed'
  const percent = item.state === 'hashing'
    ? item.hashPercent
    : item.percent
  return <li
      className="upload-queue-item"
      aria-label={`Загрузка: ${item.name}`}
      data-upload-state={item.state}
      data-needs-file={item.needsFile ? 'true' : undefined}
    >
    <div className="upload-queue-title">
      <span
        aria-hidden="true"
        className="upload-file-mark"
      >
        <Icon name={completed ? 'check' : 'file'} />
      </span>

      <div className="upload-file-copy">
        <strong title={item.name}>{item.name}</strong>
        <div className="upload-file-statusline">
          <span className="muted" role="status">
            {uploadStateLabels[item.state]}
          </span>
          {completed ? (
            <span className="upload-file-size">
              · {formatBytes(item.size)}
            </span>
          ) : null}
        </div>
      </div>

      {!completed ? (
        <span
          aria-hidden="true"
          className="upload-file-percent"
        >
          {percent}%
        </span>
      ) : null}
    </div>

    <progress
      aria-label={`Прогресс: ${item.name}`}
      className="upload-progress-bar"
      max={100}
      value={percent}
    >
      {percent}%
    </progress>

    {!completed ? (
      <p className="upload-details muted">
        {item.state === 'hashing'
          ? `${formatBytes(item.hashedBytes ?? 0)} из ${formatBytes(item.size)} проверено`
          : `${formatBytes(item.committedBytes)} из ${formatBytes(item.size)}`}
      </p>
    ) : null}
    {item.error ? <p className="inline-alert" role="alert">{item.error}</p> : null}
    {reselectionError ? <p className="inline-alert" role="alert">{reselectionError}</p> : null}
    <div className="state-actions">
      {canPause ? <button aria-label={`Пауза: ${item.name}`} className="button button--ghost" onClick={() => queue.pause(item.id)} type="button">Пауза</button> : null}
      {canResume ? <button aria-label={`Продолжить: ${item.name}`} className="button button--ghost" onClick={() => queue.resume(item.id)} type="button">{item.state === 'error' && !item.uploadId ? 'Повторить загрузку' : 'Продолжить'}</button> : null}
      {item.needsFile ? <label className="button button--ghost">Выбрать исходный файл<input aria-label={`Исходный файл: ${item.name}`} className="sr-only upload-input" type="file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; setReselectionError(null); void queue.reselect(item.id, file).catch((error: unknown) => setReselectionError(error instanceof Error ? error.message : 'Не удалось проверить исходный файл.')) }} /></label> : null}
      {canCancel ? <button aria-label={`Отменить загрузку: ${item.name}`} className="button button--ghost" onClick={() => queue.cancel(item.id)} type="button">Отменить загрузку</button> : null}
    </div>
  </li>
}

function downloadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'network') return 'Сервер недоступен. Не удалось начать скачивание.'
    if (error.kind === 'authentication') return 'Сессия истекла. Войдите снова.'
    if (error.status === 404) return 'Этот файл больше недоступен.'
  }
  return 'Не удалось скачать файл. Попробуйте ещё раз.'
}

function archiveDownloadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'network') return 'Сервер недоступен. Не удалось начать скачивание ZIP.'
    if (error.kind === 'authentication') return 'Сессия истекла. Войдите снова.'
    if (error.status === 403) return 'Нет доступа к одному из выбранных объектов.'
    if (error.status === 404) return 'Один из выбранных объектов больше недоступен. Обновите список.'
    if (error.status === 409) return 'Состав архива изменился. Обновите список и попробуйте снова.'
    if (error.status === 400 || error.status === 413 || error.status === 422) return 'Выбор превышает ограничения архива или содержит недоступные объекты. Уменьшите выбор и попробуйте снова.'
    if (error.status === 429) return 'Слишком много запросов. Подождите и попробуйте снова.'
    if (error.status === 503) return 'Сервер сейчас занят. Попробуйте позже.'
  }
  return 'Не удалось подготовить ZIP. Попробуйте ещё раз.'
}

function parseFolderId(value?: string): number | null {
  if (value === undefined) return null
  if (!/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function readStateCrumbs(state: unknown): Crumb[] {
  const candidate = (state as FolderLocationState | null)?.crumbs
  if (!Array.isArray(candidate)) return []
  return candidate.filter((crumb): crumb is Crumb => Number.isSafeInteger(crumb?.id) && crumb.id > 0 && typeof crumb.name === 'string')
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Неизвестно' : date.toLocaleDateString('ru-RU')
}
