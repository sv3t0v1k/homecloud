import { useEffect, useState, type FormEvent } from 'react'

import { ApiError } from '../api/errors'
import { formatBytes } from '../ui/formatBytes'
import { getAdminUsers, type AdminUserPage } from './api'

const PAGE_SIZE = 25

type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden'

export function UsersSection() {
  const [draftSearch, setDraftSearch] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<AdminUserPage | null>(null)
  const [status, setStatus] = useState<LoadStatus>('loading')

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

  const totalPages = result && result.pageSize > 0 ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1

  return <section aria-labelledby="admin-users-title" className="account-section admin-users-section">
    <h3 id="admin-users-title">Пользователи</h3>
    <form className="admin-users-search" onSubmit={submitSearch} role="search">
      <label className="field">Поиск пользователей
        <input autoComplete="off" className="input" maxLength={100} onChange={(event) => setDraftSearch(event.target.value)} placeholder="Имя или email" type="search" value={draftSearch} />
      </label>
      <button className="button button--primary" disabled={status === 'loading'} type="submit">Найти</button>
    </form>

    {status === 'loading' ? <p role="status">Загружаем пользователей…</p> : null}
    {status === 'error' ? <div className="admin-users-message"><p role="alert">Не удалось загрузить пользователей. Проверьте подключение и повторите попытку.</p><button className="button button--ghost" onClick={() => setRefresh((value) => value + 1)} type="button">Повторить загрузку</button></div> : null}
    {status === 'forbidden' ? <p className="admin-users-message" role="alert">Доступ к списку пользователей запрещён. Требуются права администратора.</p> : null}

    {status === 'ready' && result ? <>
      {result.items.length === 0 ? <p className="admin-users-message" role="status">{search ? `По запросу «${search}» пользователи не найдены.` : 'Пользователи не найдены.'}</p> : <div className="admin-users-table-wrap">
        <table className="admin-users-table">
          <thead><tr><th scope="col">Имя</th><th scope="col">Email</th><th scope="col">Роль</th><th scope="col">Занято</th><th scope="col">Квота</th><th scope="col">Файлы</th><th scope="col">Папки</th><th scope="col">Создан</th></tr></thead>
          <tbody>{result.items.map((user) => <tr key={user.id}>
            <td>{user.name}</td>
            <td>{user.email}</td>
            <td>{user.role === 'ADMIN' ? 'Администратор' : 'Пользователь'}</td>
            <td>{formatBytes(user.storageUsed)}</td>
            <td>{formatBytes(user.storageQuota)}</td>
            <td>{user.fileCount.toLocaleString('ru-RU')}</td>
            <td>{user.folderCount.toLocaleString('ru-RU')}</td>
            <td><time dateTime={user.createdAt}>{formatDate(user.createdAt)}</time></td>
          </tr>)}</tbody>
        </table>
      </div>}
      {result.total > 0 ? <footer className="admin-users-pagination">
        <p>Страница {result.page} из {totalPages}. Всего пользователей: {result.total.toLocaleString('ru-RU')}.</p>
        <nav aria-label="Страницы пользователей">
          <button className="button button--ghost" disabled={result.page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">Предыдущая страница</button>
          <button className="button button--ghost" disabled={result.page >= totalPages} onClick={() => setPage((value) => value + 1)} type="button">Следующая страница</button>
        </nav>
      </footer> : null}
    </> : null}
  </section>
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Дата неизвестна' : date.toLocaleDateString('ru-RU')
}
