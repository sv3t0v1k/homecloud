import type { ReactNode } from 'react'

import { Icon } from '../ui/Icon'

type AuthScreenProps = {
  mode: 'loading' | 'form' | 'unavailable'
  children: ReactNode
}

export function AuthScreen({ mode, children }: AuthScreenProps) {
  const loading = mode === 'loading'

  return (
    <main
      className="auth-page liquid-auth-page"
      role={loading ? 'status' : undefined}
    >
      <section className="liquid-auth-card" data-mode={mode}>
        <div className="liquid-auth-brand">
          <span className="liquid-auth-logo">
            <Icon name="cloud" width={36} height={36} />
          </span>
          <h1>HomeCloud</h1>
          <p>Ваши файлы — в одном месте.</p>
        </div>

        {loading ? (
          <div className="liquid-auth-loading">
            {children}
            <span className="liquid-auth-progress" aria-hidden="true">
              <span />
            </span>
          </div>
        ) : (
          <div className="liquid-auth-reveal">
            <div className="liquid-auth-clip">
              <div className="liquid-auth-content">
                {children}
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}
