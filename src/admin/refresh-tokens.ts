import { getUpdatesDb } from '../db'
import { generateRefreshToken, hashRefreshToken } from './jwt'

export interface RefreshTokenIssuance {
  raw: string
  expiresAt: string
}

export interface RefreshTokenLookup {
  userId: number
  expiresAt: string
}

interface RefreshTokenRow {
  id: number
  user_id: number
  token_hash: string
  expires_at: string
  revoked_at: string | null
  created_at: string
}

export function issueRefreshToken(
  userId: number,
  meta: { userAgent?: string | null; ip?: string | null } = {}
): RefreshTokenIssuance {
  const db = getUpdatesDb()
  const { raw, hash, expiresAt } = generateRefreshToken()
  const now = new Date().toISOString()

  db.run(
    `INSERT INTO admin_refresh_tokens (user_id, token_hash, expires_at, created_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, hash, expiresAt, now, meta.userAgent ?? null, meta.ip ?? null]
  )

  return { raw, expiresAt }
}

export function lookupRefreshToken(raw: string): RefreshTokenLookup | null {
  if (!raw) return null
  const db = getUpdatesDb()
  const hash = hashRefreshToken(raw)
  const row = db
    .query<RefreshTokenRow, [string]>(
      `SELECT * FROM admin_refresh_tokens WHERE token_hash = ? LIMIT 1`
    )
    .get(hash)

  if (!row) return null
  if (row.revoked_at) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) return null

  return { userId: row.user_id, expiresAt: row.expires_at }
}

export function revokeRefreshToken(raw: string): void {
  if (!raw) return
  const db = getUpdatesDb()
  const hash = hashRefreshToken(raw)
  const now = new Date().toISOString()
  db.run(
    `UPDATE admin_refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
    [now, hash]
  )
}

export function revokeAllUserTokens(userId: number): void {
  const db = getUpdatesDb()
  const now = new Date().toISOString()
  db.run(
    `UPDATE admin_refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
    [now, userId]
  )
}

export function rotateRefreshToken(
  oldRaw: string,
  meta: { userAgent?: string | null; ip?: string | null } = {}
): { userId: number; refreshToken: RefreshTokenIssuance } | null {
  const lookup = lookupRefreshToken(oldRaw)
  if (!lookup) return null
  revokeRefreshToken(oldRaw)
  const refreshToken = issueRefreshToken(lookup.userId, meta)
  return { userId: lookup.userId, refreshToken }
}
