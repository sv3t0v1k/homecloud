import { type FormEvent, useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'

import { ApiError } from '../api/errors'
import { AuthScreen } from './AuthScreen'
import { useSession } from './SessionContext'

const LOGIN_EXIT_MS = 850

function prefersLoginMotion(): boolean {
  return window.matchMedia?.(
    '(prefers-reduced-motion: no-preference)',
  ).matches === true
}

export function LoginPage() {
  const session = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const returnPath = readReturnPath(location.state)
  const isClosing = closing && session.status === 'authenticated'
  const busy = submitting || isClosing

  useEffect(() => {
    if (!isClosing) return

    const timer = window.setTimeout(() => {
      navigate(returnPath, { replace: true })
    }, LOGIN_EXIT_MS)

    return () => window.clearTimeout(timer)
  }, [isClosing, navigate, returnPath])

  if (session.status === 'bootstrapping') {
    return (
      <AuthScreen mode="loading">
        <p>Восстанавливаем сеанс…</p>
      </AuthScreen>
    )
  }

  if (session.status === 'authenticated' && !busy) {
    return <Navigate to={returnPath} replace />
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setClosing(false)
    setSubmitting(true)
    setError(null)

    try {
      await session.login(email, password)

      // Credentials are no longer needed after successful login.
      setPassword('')

      if (prefersLoginMotion()) {
        setClosing(true)
      } else {
        navigate(returnPath, { replace: true })
      }
    } catch (caught) {
      setError(
        loginErrorMessage(caught),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthScreen mode={isClosing ? "closing" : "form"}>
      <h2 className="page-heading">Войти</h2>
          {session.status === 'anonymous' && session.notice ? (
            <p className="alert alert--warning" role="status">
              {session.notice}
            </p>
          ) : null}
          {error ? (
            <p className="alert alert--danger" role="alert">
              {error}
            </p>
          ) : null}
          <form className="auth-form" onSubmit={handleSubmit}>
            <div>
              <label className="field" htmlFor="email">Электронная почта</label>
              <input
                autoComplete="email"
                className="input"
                disabled={busy}
                id="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </div>
            <div>
              <label className="field" htmlFor="password">Пароль</label>
              <input
                autoComplete="current-password"
                className="input"
                disabled={busy}
                id="password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </div>
            <button
              className="button button--primary"
              disabled={busy}
              type="submit"
            >
              {busy ? 'Входим…' : 'Войти'}
            </button>
          </form>
    </AuthScreen>
  )
}

function readReturnPath(state: unknown): string {
  if (
    typeof state === 'object' &&
    state !== null &&
    'from' in state &&
    typeof state.from === 'string' &&
    state.from.startsWith('/') &&
    !state.from.startsWith('//')
  ) {
    return state.from
  }
  return '/files'
}

function loginErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Не удалось войти. Попробуйте ещё раз.'
  if (error.kind === 'authentication') return 'Неверная электронная почта или пароль.'
  if (error.kind === 'authorization') return 'Доступ к аккаунту ограничен.'
  if (error.kind === 'validation') return 'Проверьте электронную почту и пароль.'
  if (error.kind === 'rate-limit') return 'Слишком много попыток входа. Попробуйте позже.'
  if (error.kind === 'network') return 'Сервер недоступен. Проверьте соединение и попробуйте ещё раз.'
  return 'Не удалось войти. Попробуйте ещё раз.'
}
