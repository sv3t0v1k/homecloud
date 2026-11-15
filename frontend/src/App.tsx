import { useEffect, useRef, useState } from 'react'
import { Routes, Route, Navigate, Link, Outlet, useLocation, useNavigate, useOutletContext } from 'react-router-dom'

import { safeOperationError } from './files/operationErrors'
import { useDialogFocus } from './accessibility/useDialogFocus'
import { LoginPage } from './auth/LoginPage'
import { useSession } from './auth/SessionContext'
import { FileBrowserPage, UploadQueueProvider } from './files/FileBrowserPage'
import { TrashPage } from './files/TrashPage'
import { ProtectedRoute } from './routing/ProtectedRoute'
import { Icon } from './ui/Icon'
import { LiquidCloseButton } from './ui/LiquidCloseButton'
import { AccountDialog } from './account/AccountDialog'
import { PublicSharePage } from './sharing/PublicSharePage'
import { GlobalSearchPage } from './files/GlobalSearchPage'
import { SearchSessionProvider } from './files/useGlobalSearch'

function App() {
  return (
    <div className="app-root">
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/share/:token" element={<PublicSharePage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/files" element={<FileBrowserLayout />}>
            <Route index element={<DirectoryRoute />} />
            <Route path="folders/:folderId" element={<DirectoryRoute />} />
            <Route path="trash" element={<DirectoryRoute />} />
            <Route path="search" element={<GlobalSearchPage />} />
          </Route>
        </Route>
        <Route path="/" element={<Navigate to="/files" replace />} />
        <Route path="*" element={<div className="empty-state"><h2>Страница не найдена</h2><Link to="/files">К моим файлам</Link></div>} />
      </Routes>
    </div>
  )
}

function DirectoryRoute() {
  const { revision } = useOutletContext<{ revision: number }>()
  return <FileBrowserPage revision={revision} />
}

function FileBrowserLayout() {
  const session = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const trash = location.pathname === '/files/trash'
  const [accountOpen, setAccountOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(trash)
  const [revision, setRevision] = useState(0)
  const backgroundRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (trash) setTrashOpen(true) }, [trash])
  function closeTrash() { setTrashOpen(false); setRevision((value) => value + 1); if (trash) navigate('/files', { replace: true }) }
  return <SearchSessionProvider key={session.user?.id ?? 0} ownerId={session.user?.id ?? 0}><UploadQueueProvider ownerId={session.user?.id ?? 0}>
    <div className="app-shell ux-v2">
      <div className="app-frame" ref={backgroundRef}>
        <a className="skip-link" href="#workspace">Перейти к содержимому</a>
        <Navbar onOpenAccount={() => setAccountOpen(true)} />
        <main className="workspace" id="workspace" tabIndex={-1}><Outlet context={{ revision }} /></main>
        <button aria-label="Открыть корзину" className="trash-launcher" onClick={(event) => { event.currentTarget.focus(); setTrashOpen(true) }} type="button"><Icon name="trash" height={25} width={25} /><span aria-hidden="true" className="trash-launcher-tooltip">Корзина</span></button>
      </div>
      {trashOpen ? <TrashDialog background={backgroundRef.current} onClose={closeTrash} /> : null}
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
    </div>
  </UploadQueueProvider></SearchSessionProvider>
}

function TrashDialog({ background, onClose }: { background: HTMLElement | null; onClose(): void }) {
  const [confirming, setConfirming] = useState(false)
  const ref = useDialogFocus(onClose, undefined, !confirming)
  useEffect(() => {
    const overflow = document.body.style.overflow
    const inert = background?.inert ?? false
    if (background) background.inert = true
    document.body.style.overflow = 'hidden'
    return () => { if (background) background.inert = inert; document.body.style.overflow = overflow }
  }, [background])
  return <div className="dialog-overlay"><div aria-label="Корзина" aria-modal="true" className="dialog-surface trash-dialog" ref={ref} role="dialog" tabIndex={-1}>
    <div className="dialog-header"><h2 id="trash-dialog-heading">Корзина</h2><LiquidCloseButton aria-label="Закрыть корзину" onClick={onClose} /></div>
    <TrashPage embedded onConfirmationChange={setConfirming} />
  </div></div>
}

function Navbar({ onOpenAccount }: { onOpenAccount(): void }) {
  const session = useSession()
  const location = useLocation()
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  const [searchOpen, setSearchOpen] = useState(false)
  const searchLauncher = useRef<HTMLButtonElement>(null)
  const searchPanel = useRef<HTMLDivElement>(null)

  function closeSearch(restoreFocus = true) {
    setSearchOpen(false)
    if (restoreFocus) searchLauncher.current?.focus()
  }

  function openSearch() {
    // Preserve compatibility with existing saved search URLs.
    if (location.pathname === '/files/search') {
      document.getElementById('global-search-query')?.focus()
      return
    }
    setSearchOpen(true)
  }

  useEffect(() => {
    setSearchOpen(false)
  }, [location.key])

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target
      if (event.defaultPrevented || event.altKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== 'k' ||
        (target instanceof HTMLElement &&
          target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) ||
        document.querySelector('[aria-modal="true"]')) return

      event.preventDefault()

      if (location.pathname === '/files/search') {
        document.getElementById('global-search-query')?.focus()
      } else {
        setSearchOpen(true)
      }
    }

    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [location.pathname])

  useEffect(() => {
    if (!searchOpen) return

    function outside(event: PointerEvent) {
      if (document.querySelector('[aria-modal="true"]')) return
      if (!(event.target instanceof Node)) return

      if (!searchPanel.current?.contains(event.target) &&
          !searchLauncher.current?.contains(event.target)) {
        setSearchOpen(false)
      }
    }

    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented ||
          document.querySelector('[aria-modal="true"]')) return

      event.preventDefault()
      setSearchOpen(false)
      searchLauncher.current?.focus()
    }

    document.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', escape)

    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', escape)
    }
  }, [searchOpen])

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    setLogoutError(null)
    try {
      await session.logout()
    } catch (caught) {
      setLogoutError(
        safeOperationError(caught, 'Не удалось выйти. Повторите попытку.'),
      )
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <>
    <header className="topbar">
      <Link className="brand" to="/files"><span className="brand-mark"><Icon name="cloud" /></span><span>HomeCloud</span></Link>
      <div className="spotlight-launcher-slot">
        <button
          className="global-search-launcher button button--ghost"
          aria-label="Поиск во всех файлах"
          aria-keyshortcuts="Control+k Meta+k"
          aria-expanded={searchOpen}
          aria-controls={searchOpen ? 'homecloud-spotlight' : undefined}
          ref={searchLauncher}
          onClick={() => searchOpen ? closeSearch() : openSearch()}
          type="button"
        >
          <Icon name="search" />
          <span className="spotlight-launcher-label">Поиск</span>
        </button>
      </div>
      <div className="account-area">
        {session.status === 'authenticated' ? <button aria-label={`Открыть аккаунт: ${session.user.name}`} className="button button--ghost" onClick={(event) => { event.currentTarget.focus(); onOpenAccount() }} type="button"><Icon name="user" /><span>{session.user.name}</span></button> : null}
        {logoutError ? <span className="inline-alert" role="alert">{logoutError}</span> : null}

        <button className="button button--ghost" disabled={loggingOut} onClick={() => void handleLogout()} type="button">{loggingOut ? 'Выходим…' : 'Выйти'}</button>
      </div>
    </header>
    {searchOpen ? (
      <div
        className="spotlight-panel"
        id="homecloud-spotlight"
        ref={searchPanel}
      >
        <GlobalSearchPage onClose={() => closeSearch()} />
      </div>
    ) : null}
    </>
  )
}

export default App
