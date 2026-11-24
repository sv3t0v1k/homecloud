import { apiRequest, refreshSession } from '../api/client'
import type { User } from '../types/auth'
export interface StorageInfo { storageQuota: string | number; storageUsed: string | number; storageReserved?: string | number; storageAvailable?: string | number; fileCount: number; folderCount: number }
export interface AdminUser { id: number; name: string; email: string; role: 'ADMIN' | 'USER'; isActive: boolean; storageQuota: string; storageUsed: string; fileCount: number; folderCount: number; createdAt: string }
export interface AdminUserPage { items: AdminUser[]; page: number; pageSize: number; total: number }
export interface AdminCreateUserInput { name: string; email: string; password: string; role: AdminUser['role']; storageQuota: string }
export interface AdminUpdateUserInput { name: string; email: string; role: AdminUser['role']; storageQuota: string }
export interface AdminDeleteUserResult { deleted: true; cleanupPending: boolean }
export function getStorageInfo(signal?: AbortSignal) { return apiRequest<StorageInfo>({ method: 'GET', url: '/files/storage-info', signal }) }
export function getAdminUsers(page: number, pageSize: number, search: string, signal?: AbortSignal) { return apiRequest<AdminUserPage>({ method: 'GET', url: '/admin/users', params: { page, pageSize, search }, signal }) }
export function createAdminUser(data: AdminCreateUserInput) { return apiRequest<AdminUser>({ method: 'POST', url: '/admin/users', data }) }
export function updateAdminUser(id: number, data: AdminUpdateUserInput) { return apiRequest<AdminUser>({ method: 'PATCH', url: `/admin/users/${id}`, data }) }
export function changeAdminUserPassword(id: number, newPassword: string) { return apiRequest<{ passwordChanged: true; sessionsRevoked: true }>({ method: 'PUT', url: `/admin/users/${id}/password`, data: { newPassword } }) }
export function changeAdminUserStatus(id: number, isActive: boolean) { return apiRequest<AdminUser>({ method: 'PATCH', url: `/admin/users/${id}/status`, data: { isActive } }) }
export function deleteAdminUser(id: number) { return apiRequest<AdminDeleteUserResult>({ method: 'DELETE', url: `/admin/users/${id}` }) }
export function updateProfile(name: string, avatar?: string) { return apiRequest<User>({ method: 'PATCH', url: '/users/me', data: { name, ...(avatar === undefined ? {} : { avatar }) } }) }
export async function changePassword(oldPassword: string, newPassword: string) { await refreshSession(); return apiRequest<{ message: string }>({ method: 'POST', url: '/auth/change-password', data: { oldPassword, newPassword }, skipRefresh: true }) }
