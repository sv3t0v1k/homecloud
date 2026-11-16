import { type ReactNode, useState } from 'react'

import { Icon } from '../ui/Icon'

type AuthScreenProps = {
  mode: 'loading' | 'form' | 'closing' | 'unavailable'
  children: ReactNode
}

export function AuthScreen({ mode, children }: AuthScreenProps) {
  const loading = mode === 'loading'
  const [entered, setEntered] = useState(false)

  function finishEntering() {
    if (mode === 'form') setEntered(true)
  }

  return (
    <main
      className="auth-page liquid-auth-page" data-mode={mode}
      role={loading ? 'status' : undefined}
    >
      <section
        className="liquid-auth-card"
        data-mode={mode}
        data-entered={entered}
      >
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
          <div
            className="liquid-auth-reveal"
            onFocusCapture={finishEntering}
            onSubmitCapture={finishEntering}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) {
                finishEntering()
              }
            }}
          >
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
