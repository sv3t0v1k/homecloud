export interface LoginDto {
  email: string
  password: string
}

export interface Tokens {
  accessToken: string
  refreshToken: string
}

export interface User {
  id: number
  email: string
  name: string
  isActive: boolean
  isEmailVerified: boolean
  role: 'ADMIN' | 'USER'
  avatar: string | null
  storageQuota: string | number
  storageUsed: string | number
  createdAt: string
  updatedAt: string
}
