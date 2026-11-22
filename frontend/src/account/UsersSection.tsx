import { useEffect, useRef, useState, type FormEvent } from 'react'

import { ApiError } from '../api/errors'
import { formatBytes } from '../ui/formatBytes'
import { Icon } from '../ui/Icon'
import {
  changeAdminUserPassword,
  changeAdminUserStatus,
  createAdminUser,
  deleteAdminUser,
  getAdminUsers,
  updateAdminUser,
  type AdminUser,
  type AdminUserPage,
} from './api'

const PAGE_SIZE = 25
const DEFAULT_QUOTA = '10737418240'
const MAX_QUOTA = 9007199254740991n

type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden'
type Role = AdminUser['role']
type Editor =
  | { kind: 'create'; name: string; email: string; password: string; confirmation: string; role: Role; quota: string }
  | { kind: 'edit'; user: AdminUser; name: string; email: string; role: Role; quota: string }
  | { kind: 'password'; user: AdminUser; password: string; confirmation: string }
  | { kind: 'status'; user: AdminUser }
  | { kind: 'delete'; user: AdminUser; confirmation: string }

type UsersSectionProps = {
  currentUserId?: number
  onCurrentUserSessionRevoked?: () => void
  onCurrentUserUpdated?: (user: AdminUser) => void
}

export function UsersSection({ currentUserId, onCurrentUserSessionRevoked, onCurrentUserUpdated }: UsersSectionProps) {
  const [draftSearch, setDraftSearch] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<AdminUserPage | null>(null)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const mutationLock = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')

    void getAdminUsers(page, PAGE_SIZE, search, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setResult(value)
          setStatus('ready')
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setResult(null)
        setStatus(cause instanceof ApiError && (cause.status === 403 || cause.kind === 'authorization') ? 'forbidden' : 'error')
      })

    return () => controller.abort()
  }, [page, refresh, search])

  function submitSearch(event: FormEvent) {
    event.preventDefault()
    setPage(1)
    setSearch(draftSearch.trim())
  }

  function openEditor(next: Editor) {
    if (mutationLock.current) return
    setError(null)
    setNotice(null)
    setWarning(null)
    setEditor(next)
  }

  function closeEditor() {
    if (!mutationLock.current) setEditor(null)
  }

  async function submitMutation(event: FormEvent) {
    event.preventDefault()
    if (!editor || mutationLock.current) return

    setError(null)
    setNotice(null)
    setWarning(null)

    if ((editor.kind === 'create' || editor.kind === 'password') && editor.password !== editor.confirmation) {
      setError('Пароли не совпадают.')
      return
    }
    if ((editor.kind === 'create' || editor.kind === 'password') && !validPassword(editor.password)) {
      setError('Пароль должен содержать от 12 символов и не более 72 байт в UTF-8.')
      return
    }
    if ((editor.kind === 'create' || editor.kind === 'edit') && !editor.name.trim()) {
      setError('Введите имя пользователя.')
      return
    }
    if ((editor.kind === 'create' || editor.kind === 'edit') && !validQuota(editor.quota)) {
      setError(`Введите целую квоту от 0 до ${MAX_QUOTA.toString()} байт без пробелов и ведущих нулей.`)
      return
    }

    const currentEditor = editor
    mutationLock.current = true
    setBusy(true)

    try {
      if (currentEditor.kind === 'create') {
        const created = await createAdminUser({
          name: currentEditor.name.trim(),
          email: currentEditor.email.trim(),
          password: currentEditor.password,
          role: currentEditor.role,
          storageQuota: currentEditor.quota,
        })
        setEditor(null)
        setNotice(`Пользователь ${created.email} создан.`)
        setPage(1)
        setRefresh((value) => value + 1)
      } else if (currentEditor.kind === 'edit') {
        const target = currentEditor.user
        const updated = await updateAdminUser(target.id, {
          name: currentEditor.name.trim(),
          email: currentEditor.email.trim(),
          role: currentEditor.role,
          storageQuota: currentEditor.quota,
        })
        setEditor(null)
        setNotice(`Данные пользователя ${updated.email} обновлены.`)
        if (target.id === currentUserId) {
          if (updated.role !== target.role || updated.email !== target.email) onCurrentUserSessionRevoked?.()
          else onCurrentUserUpdated?.(updated)
        }
        setRefresh((value) => value + 1)
      } else if (currentEditor.kind === 'password') {
        await changeAdminUserPassword(currentEditor.user.id, currentEditor.password)
        setEditor(null)
        setNotice('Пароль изменён. Все сеансы пользователя отозваны.')
        if (currentEditor.user.id === currentUserId) onCurrentUserSessionRevoked?.()
      } else if (currentEditor.kind === 'status') {
        const target = currentEditor.user
        const updated = await changeAdminUserStatus(target.id, !target.isActive)
        setEditor(null)
        setNotice(updated.isActive
          ? 'Пользователь реактивирован. Ранее отозванные ссылки и сеансы не восстановлены.'
          : 'Пользователь заблокирован. Его сеансы, публичные ссылки и разрешения на скачивание отозваны.')
        if (target.id === currentUserId && updated.isActive !== target.isActive) onCurrentUserSessionRevoked?.()
        setRefresh((value) => value + 1)
      } else {
        const target = currentEditor.user
        const deleted = await deleteAdminUser(target.id)
        setEditor(null)
        if (deleted.cleanupPending) {
          setWarning(`Аккаунт ${target.email} удалён, но физическая очистка части данных не завершена. Требуется проверка хранилища администратором.`)
        } else {
          setNotice(`Пользователь ${target.email} и связанные данные удалены.`)
        }
        if (result?.items.length === 1 && page > 1) setPage((value) => value - 1)
        else setRefresh((value) => value + 1)
      }
    } catch (cause) {
      setError(adminMutationError(cause))
    } finally {
      mutationLock.current = false
      setBusy(false)
    }
  }

  const totalPages = result && result.pageSize > 0 ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1

  return <section aria-labelledby="admin-users-title" className="account-section admin-users-section">
    <div className="admin-users-heading">
      <h3 id="admin-users-title">Пользователи</h3>
      <button className="button button--primary" disabled={busy} onClick={() => openEditor({ kind: 'create', name: '', email: '', password: '', confirmation: '', role: 'USER', quota: DEFAULT_QUOTA })} type="button">Создать пользователя</button>
    </div>
    <form className="admin-users-search" onSubmit={submitSearch} role="search">
      <label className="field">Поиск пользователей
        <input autoComplete="off" className="input" maxLength={100} onChange={(event) => setDraftSearch(event.target.value)} placeholder="Имя или email" type="search" value={draftSearch} />
      </label>
      <button className="button button--primary" disabled={status === 'loading' || busy} type="submit">Найти</button>
    </form>

    {notice ? <p className="admin-users-message" role="status">{notice}</p> : null}
    {warning ? <p className="alert alert--danger" role="alert">{warning}</p> : null}

    {editor ? <div aria-labelledby="admin-user-editor-title" className="admin-user-editor">
      <div className="admin-user-editor-heading">
        <h4 id="admin-user-editor-title">{editorTitle(editor)}</h4>
        <button className="button button--ghost" disabled={busy} onClick={closeEditor} type="button">Отмена</button>
      </div>
      <form onSubmit={(event) => void submitMutation(event)}>
        {editor.kind === 'create' || editor.kind === 'edit' ? <>
          <div className="admin-user-form-grid">
            <label className="field">Имя
              <input autoComplete="off" className="input" disabled={busy} maxLength={100} onChange={(event) => setEditor({ ...editor, name: event.target.value })} required value={editor.name} />
            </label>
            <label className="field">Email
              <input autoComplete="off" className="input" disabled={busy} maxLength={255} onChange={(event) => setEditor({ ...editor, email: event.target.value })} required type="email" value={editor.email} />
            </label>
            <label className="field">Роль
              <select className="input" disabled={busy} onChange={(event) => setEditor({ ...editor, role: event.target.value as Role })} value={editor.role}>
                <option value="USER">Пользователь</option>
                <option value="ADMIN">Администратор</option>
              </select>
            </label>
            <label className="field">Квота, байты
              <input className="input" disabled={busy} inputMode="numeric" maxLength={16} onChange={(event) => setEditor({ ...editor, quota: event.target.value })} pattern="0|[1-9][0-9]*" required value={editor.quota} />
              <span className="account-hint">{validQuota(editor.quota) ? formatBytes(editor.quota) : 'Только целое неотрицательное число байт.'}</span>
            </label>
          </div>
          {editor.kind === 'create' ? <div className="admin-user-form-grid">
            <label className="field">Пароль
              <input autoComplete="new-password" className="input" disabled={busy} minLength={12} onChange={(event) => setEditor({ ...editor, password: event.target.value })} required type="password" value={editor.password} />
            </label>
            <label className="field">Повторите пароль
              <input autoComplete="new-password" className="input" disabled={busy} minLength={12} onChange={(event) => setEditor({ ...editor, confirmation: event.target.value })} required type="password" value={editor.confirmation} />
            </label>
          </div> : <p className="account-hint">При изменении email или роли все сеансы пользователя будут отозваны. Квота не может быть меньше уже занятого и зарезервированного места.</p>}
        </> : null}

        {editor.kind === 'password' ? <>
          <p>Новый пароль для <strong>{editor.user.email}</strong>. После изменения все сеансы пользователя будут отозваны.</p>
          <div className="admin-user-form-grid">
            <label className="field">Новый пароль
              <input autoComplete="new-password" className="input" disabled={busy} minLength={12} onChange={(event) => setEditor({ ...editor, password: event.target.value })} required type="password" value={editor.password} />
            </label>
            <label className="field">Повторите новый пароль
              <input autoComplete="new-password" className="input" disabled={busy} minLength={12} onChange={(event) => setEditor({ ...editor, confirmation: event.target.value })} required type="password" value={editor.confirmation} />
            </label>
          </div>
        </> : null}

        {editor.kind === 'status' ? <p>{editor.user.isActive
          ? `Заблокировать ${editor.user.email}? Вход будет запрещён, все сеансы, активные публичные ссылки и разрешения на скачивание будут отозваны.`
          : `Реактивировать ${editor.user.email}? Пользователь снова сможет войти, но прежние сеансы и публичные ссылки не восстановятся.`}</p> : null}

        {editor.kind === 'delete' ? <>
          <p>Удаление <strong>{editor.user.email}</strong> необратимо. Будут удалены аккаунт, файлы, папки, сеансы и связанные разрешения. Операции восстановления хранилища могут безопасно заблокировать удаление.</p>
          <label className="field">Введите email пользователя для подтверждения
            <input autoComplete="off" className="input" disabled={busy} onChange={(event) => setEditor({ ...editor, confirmation: event.target.value })} required type="email" value={editor.confirmation} />
          </label>
        </> : null}

        {error ? <p className="alert alert--danger" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button className="button button--ghost" disabled={busy} onClick={closeEditor} type="button">Отмена</button>
          <button className={`button ${editor.kind === 'delete' || (editor.kind === 'status' && editor.user.isActive) ? 'button--danger' : 'button--primary'}`} disabled={busy || (editor.kind === 'delete' && editor.confirmation.trim().toLowerCase() !== editor.user.email.toLowerCase())} type="submit">
            {busy ? 'Выполняется…' : editorSubmitLabel(editor)}
          </button>
        </div>
      </form>
    </div> : null}

    {status === 'loading' ? <p role="status">Загружаем пользователей…</p> : null}
    {status === 'error' ? <div className="admin-users-message"><p role="alert">Не удалось загрузить пользователей. Проверьте подключение и повторите попытку.</p><button className="button button--ghost" onClick={() => setRefresh((value) => value + 1)} type="button">Повторить загрузку</button></div> : null}
    {status === 'forbidden' ? <p className="admin-users-message" role="alert">Доступ к списку пользователей запрещён. Требуются права администратора.</p> : null}

    {status === 'ready' && result ? <>
      {result.items.length === 0 ? <p className="admin-users-message" role="status">{search ? `По запросу «${search}» пользователи не найдены.` : 'Пользователи не найдены.'}</p> : <div className="admin-users-table-wrap">
        <table className="admin-users-table">
          <thead><tr><th scope="col">Имя</th><th scope="col">Email</th><th scope="col">Роль</th><th scope="col">Статус</th><th scope="col">Занято</th><th scope="col">Квота</th><th scope="col">Файлы</th><th scope="col">Папки</th><th scope="col">Создан</th><th scope="col">Действия</th></tr></thead>
          <tbody>{result.items.map((user) => <tr key={user.id}>
            <td>{user.name}</td>
            <td>{user.email}</td>
            <td>{user.role === 'ADMIN' ? 'Администратор' : 'Пользователь'}</td>
            <td>{user.isActive ? 'Активен' : 'Заблокирован'}</td>
            <td>{formatBytes(user.storageUsed)}</td>
            <td>{formatBytes(user.storageQuota)}</td>
            <td>{user.fileCount.toLocaleString('ru-RU')}</td>
            <td>{user.folderCount.toLocaleString('ru-RU')}</td>
            <td><time dateTime={user.createdAt}>{formatDate(user.createdAt)}</time></td>
            <td><div className="admin-user-actions">
              <button className="icon-button" disabled={busy} onClick={() => openEditor({ kind: 'edit', user, name: user.name, email: user.email, role: user.role, quota: user.storageQuota })} type="button" aria-label={`Редактировать ${user.name}`}><Icon name="edit" /></button>
              <button className="icon-button" disabled={busy} onClick={() => openEditor({ kind: 'password', user, password: '', confirmation: '' })} type="button" aria-label={`Сменить пароль ${user.name}`}><Icon name="key" /></button>
              <button className="icon-button" disabled={busy} onClick={() => openEditor({ kind: 'status', user })} type="button" aria-label={user.isActive ? `Заблокировать ${user.name}` : `Реактивировать ${user.name}`}><Icon name={user.isActive ? 'lock' : 'user'} /></button>
              <button className="icon-button" disabled={busy || user.id === currentUserId} onClick={() => openEditor({ kind: 'delete', user, confirmation: '' })} title={user.id === currentUserId ? 'Нельзя удалить собственный аккаунт' : undefined} type="button" aria-label={`Удалить ${user.name}`}><Icon name="trash" /></button>
            </div></td>
          </tr>)}</tbody>
        </table>
      </div>}
      {result.total > 0 ? <footer className="admin-users-pagination">
        <p>Страница {result.page} из {totalPages}. Всего пользователей: {result.total.toLocaleString('ru-RU')}.</p>
        <nav aria-label="Страницы пользователей">
          <button className="button button--ghost" disabled={busy || result.page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">Предыдущая страница</button>
          <button className="button button--ghost" disabled={busy || result.page >= totalPages} onClick={() => setPage((value) => value + 1)} type="button">Следующая страница</button>
        </nav>
      </footer> : null}
    </> : null}
  </section>
}

function editorTitle(editor: Editor): string {
  if (editor.kind === 'create') return 'Новый пользователь'
  if (editor.kind === 'edit') return `Редактирование: ${editor.user.email}`
  if (editor.kind === 'password') return 'Смена пароля'
  if (editor.kind === 'status') return editor.user.isActive ? 'Блокировка пользователя' : 'Реактивация пользователя'
  return 'Удаление пользователя'
}

function editorSubmitLabel(editor: Editor): string {
  if (editor.kind === 'create') return 'Создать'
  if (editor.kind === 'edit') return 'Сохранить изменения'
  if (editor.kind === 'password') return 'Изменить пароль пользователя'
  if (editor.kind === 'status') return editor.user.isActive ? 'Заблокировать пользователя' : 'Реактивировать пользователя'
  return 'Удалить навсегда'
}

function validPassword(value: string): boolean {
  return Array.from(value).length >= 12 && new TextEncoder().encode(value).length <= 72 && !value.includes('\0')
}

function validQuota(value: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > MAX_QUOTA.toString().length) return false
  return BigInt(value) <= MAX_QUOTA
}

function adminMutationError(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'Не удалось выполнить операцию. Повторите попытку.'
  if (cause.kind === 'network') return 'Сервер недоступен. Проверьте подключение и повторите попытку.'
  if (cause.kind === 'authentication' || cause.status === 401) return 'Сессия истекла. Войдите снова.'
  if (cause.kind === 'authorization' || cause.status === 403) return 'Недостаточно прав для этой операции.'
  if (cause.code === 'EMAIL_ALREADY_EXISTS') return 'Пользователь с таким email уже существует.'
  if (cause.code === 'QUOTA_BELOW_COMMITMENTS') return 'Квота меньше занятого или зарезервированного места. Увеличьте значение.'
  if (cause.code === 'LAST_ACTIVE_ADMIN') return 'Нельзя заблокировать, понизить или удалить последнего активного администратора.'
  if (cause.code === 'CANNOT_DELETE_SELF') return 'Нельзя удалить собственный аккаунт администратора.'
  if (cause.code === 'USER_RECOVERY_REQUIRED') return 'Удаление приостановлено: сначала завершите восстановление данных пользователя.'
  if (cause.code === 'USER_STORAGE_OPERATIONS_ACTIVE') return 'Удаление приостановлено: дождитесь завершения активных операций хранилища.'
  if (cause.code === 'USER_NOT_FOUND' || cause.status === 404) return 'Пользователь уже удалён или недоступен. Обновите список.'
  if (cause.code === 'INVALID_QUOTA') return 'Проверьте квоту: нужна точная строка с целым числом байт.'
  if (cause.status === 400 || cause.status === 422) return 'Проверьте введённые данные пользователя.'
  if (cause.status === 409) return 'Операция конфликтует с текущим состоянием пользователя. Обновите список и повторите.'
  return 'Не удалось выполнить операцию. Повторите попытку.'
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Дата неизвестна' : date.toLocaleDateString('ru-RU')
}
