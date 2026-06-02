import { getUpdatesDb } from '../db'

export interface AdminUser {
  id: number
  email: string
  passwordHash: string
  isActive: boolean
  createdAt: string
  updatedAt: string
  lastLoginAt: string | null
}

interface AdminUserRow {
  id: number
  email: string
  password_hash: string
  is_active: number
  created_at: string
  updated_at: string
  last_login_at: string | null
}

function rowToUser(row: AdminUserRow): AdminUser {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function getBcryptCost(): number {
  const raw = process.env.ADMIN_PASSWORD_BCRYPT_COST?.trim()
  if (!raw) return 12
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 4 || parsed > 15) return 12
  return parsed
}

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: 'bcrypt', cost: getBcryptCost() })
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash)
  } catch {
    return false
  }
}

export async function createAdminUser(email: string, password: string): Promise<AdminUser> {
  const db = getUpdatesDb()
  const normalized = normalizeEmail(email)
  if (!normalized) throw new Error('Email is required')
  if (password.length < 12) throw new Error('Password must be at least 12 characters')

  const passwordHash = await hashPassword(password)
  const now = new Date().toISOString()

  const result = db.run(
    `INSERT INTO admin_users (email, password_hash, is_active, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`,
    [normalized, passwordHash, now, now]
  )

  const user = findAdminUserById(Number(result.lastInsertRowid))
  if (!user) throw new Error('Failed to load newly created admin user')
  return user
}

export function findAdminUserByEmail(email: string): AdminUser | null {
  const db = getUpdatesDb()
  const row = db
    .query<AdminUserRow, [string]>(`SELECT * FROM admin_users WHERE email = ? LIMIT 1`)
    .get(normalizeEmail(email))
  return row ? rowToUser(row) : null
}

export function findAdminUserById(id: number): AdminUser | null {
  const db = getUpdatesDb()
  const row = db
    .query<AdminUserRow, [number]>(`SELECT * FROM admin_users WHERE id = ? LIMIT 1`)
    .get(id)
  return row ? rowToUser(row) : null
}

export function updateLastLogin(userId: number): void {
  const db = getUpdatesDb()
  const now = new Date().toISOString()
  db.run(`UPDATE admin_users SET last_login_at = ?, updated_at = ? WHERE id = ?`, [now, now, userId])
}

export async function updateAdminPassword(userId: number, newPassword: string): Promise<void> {
  if (newPassword.length < 12) throw new Error('Password must be at least 12 characters')
  const db = getUpdatesDb()
  const passwordHash = await hashPassword(newPassword)
  const now = new Date().toISOString()
  db.run(`UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?`, [
    passwordHash,
    now,
    userId,
  ])
}

export function hasAnyAdminUser(): boolean {
  const db = getUpdatesDb()
  const row = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM admin_users`).get()
  return (row?.count ?? 0) > 0
}
