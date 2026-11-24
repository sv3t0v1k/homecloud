import { createContext, createElement, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { tokenStorage } from '../auth/tokenStorage'
import { ApiError } from '../api/errors'
import { normalizeSearchQuery, SEARCH_MAX_OFFSET, searchFiles, searchRetryAfter } from './searchApi'
import type { SearchPage } from './searchTypes'

type SearchSnapshot = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: SearchPage | null
  error: ApiError | null
}

const idle: SearchSnapshot = { status: 'idle', data: null, error: null }
const SearchContext = createContext<SearchSession | null>(null)
const CACHE_TTL = 60000
const CACHE_LIMIT = 10

type SpotlightLocation = {
  query: string | null
  offset: number
}

type SpotlightPosition = {
  scrollTop: number
  focusResult: string | null
}

const emptySpotlightLocation: SpotlightLocation = {
  query: null,
  offset: 0,
}

const emptySpotlightPosition: SpotlightPosition = {
  scrollTop: 0,
  focusResult: null,
}

class SearchSession {
  private version = 0
  private listeners = new Set<() => void>()
  private pages = new Map<string, { value: SearchSnapshot; at: number }>()
  private leases = new Map<string, number>()
  private providers = 0
  private pending: { key: string; controller: AbortController } | null = null
  cooldownUntil = 0

  private spotlightLocation = emptySpotlightLocation
  private spotlightPosition = emptySpotlightPosition

  constructor(readonly ownerId: number, readonly generation: number) {}

  private current = () => this.ownerId > 0 && this.generation === tokenStorage.getOwnerGeneration()

  getSpotlightLocation(): SpotlightLocation {
    return this.current()
      ? this.spotlightLocation
      : emptySpotlightLocation
  }

  getSpotlightPosition(): SpotlightPosition {
    return this.current()
      ? this.spotlightPosition
      : emptySpotlightPosition
  }

  setSpotlightLocation(location: SpotlightLocation) {
    if (!this.current()) return

    if (
      this.spotlightLocation.query === location.query &&
      this.spotlightLocation.offset === location.offset
    ) return

    this.spotlightLocation = { ...location }
    this.spotlightPosition = emptySpotlightPosition
  }

  saveSpotlightPosition(
    location: SpotlightLocation,
    position: Partial<SpotlightPosition>,
  ) {
    if (
      !this.current() ||
      this.spotlightLocation.query !== location.query ||
      this.spotlightLocation.offset !== location.offset
    ) return

    this.spotlightPosition = {
      ...this.spotlightPosition,
      ...position,
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getVersion = () => this.version
  private changed() { this.version += 1; this.listeners.forEach((listener) => listener()) }

  retain() { this.providers += 1 }
  release() {
    this.providers -= 1
    // React StrictMode immediately remounts effects. Keep that one request;
    // actual unmount/owner change still cancels and drops every cached page.
    queueMicrotask(() => {
      if (this.providers > 0) return
      this.pending?.controller.abort()
      this.pending = null
      this.pages.clear()
      this.cooldownUntil = 0
      this.spotlightLocation = emptySpotlightLocation
      this.spotlightPosition = emptySpotlightPosition
    })
  }

  snapshot(key: string | null): SearchSnapshot {
    return this.current() && key ? this.pages.get(key)?.value ?? idle : idle
  }

  private put(key: string, value: SearchSnapshot) {
    this.pages.delete(key)
    this.pages.set(key, { value, at: Date.now() })
    while (this.pages.size > CACHE_LIMIT) this.pages.delete(this.pages.keys().next().value!)
    this.changed()
  }

  acquire(query: string, offset: number, retryExpiredRateLimit = false) {
    const key = JSON.stringify([query, offset])
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1)

    const cached = this.pages.get(key)?.value
    const retryRateLimit = retryExpiredRateLimit &&
      cached?.error?.status === 429 &&
      Date.now() >= this.cooldownUntil

    this.load(query, offset, retryRateLimit)
    return () => {
      this.leases.set(key, Math.max(0, (this.leases.get(key) ?? 1) - 1))
      queueMicrotask(() => {
        if ((this.leases.get(key) ?? 0) > 0) return
        this.leases.delete(key)
        if (this.pending?.key !== key) return
        this.pending.controller.abort()
        this.pending = null
        this.pages.delete(key)
        this.changed()
      })
    }
  }

  load(query: string, offset: number, force = false) {
    if (!this.current() || !normalizeSearchQuery(query) || !Number.isSafeInteger(offset) || offset < 0 || offset > SEARCH_MAX_OFFSET) return
    const key = JSON.stringify([query, offset])
    if (this.pending?.key === key) return
    const cached = this.pages.get(key)
    if (!force && cached && (cached.value.status === 'error' || (cached.value.status === 'ready' && Date.now() - cached.at < CACHE_TTL))) return
    if (this.pending) {
      const prior = this.pending
      prior.controller.abort()
      this.pending = null
      if (this.pages.get(prior.key)?.value.status === 'loading') this.pages.delete(prior.key)
    }
    if (Date.now() < this.cooldownUntil) {
      this.put(key, { status: 'error', data: cached?.value.data ?? null, error: new ApiError('Поиск временно ограничен.', 'rate-limit', 429) })
      return
    }
    const request = { key, controller: new AbortController() }
    this.pending = request
    this.put(key, { status: 'loading', data: cached?.value.data ?? null, error: null })
    void searchFiles(query, offset, request.controller.signal).then((data) => {
      if (this.pending !== request || request.controller.signal.aborted || !this.current()) return
      this.pending = null
      this.put(key, { status: 'ready', data, error: null })
    }).catch((cause: unknown) => {
      if (this.pending !== request || request.controller.signal.aborted || !this.current()) return
      this.pending = null
      const error = cause instanceof ApiError ? cause : new ApiError('Не удалось выполнить поиск.', 'unknown')
      if (error.status === 429) this.cooldownUntil = searchRetryAfter(error.retryAfter)
      this.put(key, { status: 'error', data: cached?.value.data ?? null, error })
    })
  }
}

export function SearchSessionProvider({ ownerId, children }: { ownerId: number; children: ReactNode }) {
  const generation = tokenStorage.getOwnerGeneration()
  const session = useMemo(() => new SearchSession(ownerId, generation), [ownerId, generation])
  useEffect(() => { session.retain(); return () => session.release() }, [session])
  return createElement(SearchContext.Provider, { value: session }, children)
}

export function useSpotlightSession() {
  const session = useContext(SearchContext)

  if (!session) {
    throw new Error(
      'useSpotlightSession requires SearchSessionProvider',
    )
  }

  return session
}

export function useGlobalSearch(
  query: string | null,
  offset: number,
  retryExpiredRateLimit = false,
) {
  const session = useContext(SearchContext)
  if (!session) throw new Error('useGlobalSearch requires SearchSessionProvider')
  useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion)
  const key = query === null ? null : JSON.stringify([query, offset])
  useEffect(() => {
    if (query === null) return
    return session.acquire(query, offset, retryExpiredRateLimit)
  }, [session, query, offset, retryExpiredRateLimit])
  return {
    ...session.snapshot(key),
    cooldownUntil: session.cooldownUntil,
    retry: () => { if (query !== null) session.load(query, offset, true) },
  }
}
