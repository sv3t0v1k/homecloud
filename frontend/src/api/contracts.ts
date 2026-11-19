export interface ApiEnvelope<T> {
  success: true
  data: T
}

export interface BackendErrorBody {
  statusCode?: number
  code?: string
  message?: string
  timestamp?: string
  path?: string
}
