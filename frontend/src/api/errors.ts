import axios, { AxiosHeaders } from 'axios'

import type { BackendErrorBody } from './contracts'

export type ApiErrorKind =
  | 'network'
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'rate-limit'
  | 'server'
  | 'busy'
  | 'storage-capacity'
  | 'unknown'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly status?: number,
    readonly retryAfter?: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function normalizeApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error

  if (!axios.isAxiosError<BackendErrorBody>(error)) {
    return new ApiError('Unexpected application error', 'unknown')
  }

  if (!error.response) {
    return new ApiError('The server is unavailable', 'network')
  }

  const status = error.response.status
  const backendMessage = error.response.data?.message
  const code = error.response.data?.code
  const message = backendMessage || defaultMessage(status)
  const headers = error.response.headers
  const retryAfterHeader = headers instanceof AxiosHeaders
    ? headers.get('retry-after')
    : Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]
  const retryAfter = typeof retryAfterHeader === 'string' || typeof retryAfterHeader === 'number'
    ? String(retryAfterHeader)
    : undefined

  if (status === 400 || status === 422) return new ApiError(message, 'validation', status, undefined, code)
  if (status === 401) return new ApiError(message, 'authentication', status, undefined, code)
  if (status === 403) return new ApiError(message, 'authorization', status, undefined, code)
  if (status === 429) return new ApiError(message, 'rate-limit', status, retryAfter, code)
  if (status === 503 && /insufficient.*(?:ssd|hdd).*capacity/i.test(message)) return new ApiError(message, 'storage-capacity', status, retryAfter, code)
  if (status === 503 && /busy/i.test(message)) return new ApiError(message, 'busy', status, retryAfter, code)
  if (status >= 500) return new ApiError(message, 'server', status, retryAfter, code)
  return new ApiError(message, 'unknown', status, retryAfter, code)
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Your session has expired'
  if (status === 403) return 'You do not have access to this resource'
  if (status === 429) return 'Too many requests'
  if (status >= 500) return 'The server could not complete the request'
  return 'The request could not be completed'
}

/** Backend currently distinguishes capacity using its stable 503 message. */
export function isUploadCapacityError(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'storage-capacity' ||
    (error.status === 503 && /insufficient.*(?:ssd|hdd).*capacity/i.test(error.message)))
}

export function isUploadBusyError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503 && /busy/i.test(error.message)
}
