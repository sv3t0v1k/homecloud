import { apiRequest, refreshSession } from '../api/client'
import type { User } from '../types/auth'
export interface StorageInfo { storageQuota: string | number; storageUsed: string | number; storageReserved?: string | number; storageAvailable?: string | number; fileCount: number; folderCount: number }
export interface AdminUser { id: number; name: string; email: string; role: 'ADMIN' | 'USER'; isActive: boolean; storageQuota: string; storageUsed: string; fileCount: number; folderCount: number; createdAt: string }
export interface AdminUserPage { items: AdminUser[]; page: number; pageSize: number; total: number }
export function getStorageInfo(signal?: AbortSignal) { return apiRequest<StorageInfo>({ method: 'GET', url: '/files/storage-info', signal }) }
export function getAdminUsers(page: number, pageSize: number, search: string, signal?: AbortSignal) { return apiRequest<AdminUserPage>({ method: 'GET', url: '/admin/users', params: { page, pageSize, search }, signal }) }
export function updateProfile(name: string, avatar?: string) { return apiRequest<User>({ method: 'PATCH', url: '/users/me', data: { name, ...(avatar === undefined ? {} : { avatar }) } }) }
export async function changePassword(oldPassword: string, newPassword: string) { await refreshSession(); return apiRequest<{ message: string }>({ method: 'POST', url: '/auth/change-password', data: { oldPassword, newPassword }, skipRefresh: true }) }
