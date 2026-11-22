import { Icon } from '../ui/Icon'
import { InitialsAvatar } from '../ui/InitialsAvatar'
import { LiquidCloseButton } from '../ui/LiquidCloseButton'
import { formatBytes, storagePercent } from '../ui/formatBytes'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useDialogFocus } from '../accessibility/useDialogFocus'
import { useSession } from '../auth/SessionContext'
import { ApiError } from '../api/errors'
import { safeOperationError } from '../files/operationErrors'
import { changePassword, getStorageInfo, updateProfile, type StorageInfo } from './api'
import { UpdatesSection } from './UpdatesSection'
import { UsersSection } from './UsersSection'

type SettingsSection = 'profile' | 'storage' | 'security' | 'updates' | 'users'

const personalSections = [
  { id: 'profile', label: 'Профиль', icon: 'user' },
  { id: 'storage', label: 'Хранилище', icon: 'folder' },
  { id: 'security', label: 'Безопасность', icon: 'lock' },
] as const

export function AccountDialog({ onClose }: { onClose(): void }) {
  const session = useSession()
  const [section, setSection] = useState<SettingsSection>('profile')
  const [canUpdate, setCanUpdate] = useState(false)
  const isAdmin = session.user?.role === 'ADMIN'
  const activeSection =
    (section === 'updates' && !canUpdate) || (section === 'users' && !isAdmin) ? 'profile' : section
  const lock = useRef(false)
  const close = () => { if (!lock.current) onClose() }
  const dialogRef = useDialogFocus(close)
  const [name, setName] = useState(session.user?.name ?? '')
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setStorageError(null)
    void getStorageInfo(controller.signal).then((value) => {
      if (!controller.signal.aborted) setStorage(value)
    }).catch((cause) => {
      if (!controller.signal.aborted) setStorageError(safeOperationError(cause, 'Не удалось получить информацию о хранилище.'))
    })
    return () => controller.abort()
  }, [refresh])
  async function save(event: FormEvent, password: boolean) {
    event.preventDefault()
    if (lock.current) return
    setError(null)
    setNotice(null)
    if (password && newPassword !== confirmation) { setError('Новые пароли не совпадают.'); return }
    if (!password && !name.trim()) { setError('Введите имя.'); return }
    lock.current = true
    setBusy(true)
    try {
      if (password) {
        await changePassword(oldPassword, newPassword)
        session.endSession()
        onClose()
      } else {
        const updatedUser = await updateProfile(name.trim())
        session.updateUser(updatedUser)
        setNotice('Профиль сохранён.')
      }
    } catch (cause) {
      setError(cause instanceof ApiError && password && cause.message.toLowerCase().includes('current password is incorrect') ? 'Текущий пароль неверен.' : cause instanceof ApiError && cause.status === 400 ? 'Проверьте введённые значения.' : safeOperationError(cause, password ? 'Не удалось изменить пароль. Проверьте текущий пароль и повторите попытку.' : 'Не удалось сохранить профиль.'))
    } finally { lock.current = false; setBusy(false) }
  }
  function selectSection(next: SettingsSection) {
    if (lock.current || next === activeSection) return
    if ((next === 'updates' && !canUpdate) || (next === 'users' && !isAdmin)) return

    setError(null)
    setNotice(null)

    if (activeSection === 'security') {
      setOldPassword('')
      setNewPassword('')
      setConfirmation('')
    }

    setSection(next)
  }

  const percent = storage ? storagePercent(storage.storageUsed, storage.storageQuota) : null
  const showReserved = storage !== null && storage.storageReserved !== undefined && storage.storageReserved !== 0 && storage.storageReserved !== '0'
  return <div aria-label="Настройки HomeCloud" aria-modal="true" className="dialog-overlay liquid-settings-overlay" ref={dialogRef} role="dialog" tabIndex={-1}>
    <div className={`dialog-surface account-dialog liquid-settings-dialog homecloud-settings${activeSection === 'users' ? ' homecloud-settings--users' : ''}`}><header className="dialog-header"><h2>Настройки HomeCloud</h2><LiquidCloseButton
      aria-label="Закрыть"
      disabled={busy}
      onClick={close}
    /></header>
      <div className="dialog-body settings-layout">
        <nav className="settings-navigation" aria-label="Разделы настроек">
          <p className="settings-nav-caption">Личные настройки</p>

          {personalSections.map((item) => (
            <button
              key={item.id}
              aria-pressed={activeSection === item.id}
              className="settings-nav-button"
              disabled={busy}
              onClick={(event) => {
                event.currentTarget.focus()
                selectSection(item.id)
              }}
              type="button"
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}

          {canUpdate || isAdmin ? (
            <div className="settings-admin-navigation">
              <p className="settings-nav-caption">Администратор</p>
              {canUpdate ? <button
                aria-pressed={activeSection === 'updates'}
                className="settings-nav-button"
                disabled={busy}
                onClick={(event) => {
                  event.currentTarget.focus()
                  selectSection('updates')
                }}
                type="button"
              >
                <Icon name="download" />
                <span>Обновления</span>
              </button> : null}
              {isAdmin ? <button
                aria-pressed={activeSection === 'users'}
                className="settings-nav-button"
                disabled={busy}
                onClick={(event) => {
                  event.currentTarget.focus()
                  selectSection('users')
                }}
                type="button"
              >
                <Icon name="user" />
                <span>Пользователи</span>
              </button> : null}
            </div>
          ) : null}
        </nav>

        <div className="settings-pane">
        {activeSection === 'profile' ? (
        <section aria-labelledby="account-profile-title" className="account-section">
          <h3 id="account-profile-title">Профиль</h3>
          <div className="account-identity"><InitialsAvatar name={session.user?.name || session.user?.email || ''} size={48} /><div><strong>{session.user?.name || session.user?.email}</strong><p className="muted">{session.user?.email}</p></div></div>
          <form onSubmit={(event) => void save(event, false)}><label className="field">Имя<input autoComplete="name" className="input" disabled={busy} maxLength={100} onChange={(event) => setName(event.target.value)} required value={name} /></label><p className="account-hint">Email используется для входа. Его изменение и загрузка фото пока недоступны.</p><button className="button button--primary" disabled={busy} type="submit">Сохранить профиль</button></form>
        </section>
        ) : null}
        {activeSection === 'storage' ? (
        <section aria-label="Хранилище" className="account-section"><h3>Хранилище</h3>{storage ? <><p>Использовано {formatBytes(storage.storageUsed)} из {formatBytes(storage.storageQuota)}. Файлов: {storage.fileCount}. Папок: {storage.folderCount}.</p>{showReserved ? <p>Ещё {formatBytes(storage.storageReserved)} зарезервировано активными загрузками и копированиями.</p> : null}{percent !== null ? <progress aria-label="Использование хранилища" className="upload-progress-bar" max={100} value={percent} /> : null}</> : !storageError ? <p role="status">Получаем информацию о хранилище…</p> : null}{storageError ? <><p role="alert">{storageError}</p><button className="button button--ghost" onClick={() => setRefresh((value) => value + 1)} type="button">Повторить загрузку квоты</button></> : null}</section>
        ) : null}
        <UpdatesSection
          visible={activeSection === 'updates'}
          onAccessChange={setCanUpdate}
        />
        {activeSection === 'users' && isAdmin ? <UsersSection
          currentUserId={session.user?.id}
          onCurrentUserSessionRevoked={session.endSession}
          onCurrentUserUpdated={(updated) => {
            if (!session.user || session.user.id !== updated.id) return
            session.updateUser({ ...session.user, ...updated, avatar: session.user.avatar })
          }}
        /> : null}

        {activeSection === 'security' ? (
        <form className="account-section" aria-labelledby="account-security-title" onSubmit={(event) => void save(event, true)}><h3 id="account-security-title">Безопасность</h3><p className="account-hint">После смены пароля вы выйдете из этого аккаунта. На других устройствах повторный вход потребуется после истечения текущего сеанса.</p><label className="field">Текущий пароль<input autoComplete="current-password" className="input" disabled={busy} onChange={(event) => setOldPassword(event.target.value)} required type="password" value={oldPassword} /></label><label className="field">Новый пароль<input autoComplete="new-password" className="input" disabled={busy} minLength={8} onChange={(event) => setNewPassword(event.target.value)} required type="password" value={newPassword} /></label><label className="field">Повторите новый пароль<input autoComplete="new-password" className="input" disabled={busy} minLength={8} onChange={(event) => setConfirmation(event.target.value)} required type="password" value={confirmation} /></label><button className="button button--primary" disabled={busy} type="submit">Изменить пароль</button></form>
        ) : null}
        {error ? <p className="alert alert--danger" role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
        </div>
      </div>
    </div>
  </div>
}
