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

export interface ActiveSession {
  id: number
  createdAt: string
  expiresAt: string
  userAgent: string | null
  ip: string | null
}

interface RefreshTokenRow {
  id: number
  user_id: number
  token_hash: string
  expires_at: string
  revoked_at: string | null
  created_at: string
  user_agent: string | null
  ip: string | null
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

function lookupRefreshTokenRow(raw: string): RefreshTokenRow | null {
  if (!raw) return null
  const db = getUpdatesDb()
  const hash = hashRefreshToken(raw)
  return (
    db
      .query<RefreshTokenRow, [string]>(
        `SELECT * FROM admin_refresh_tokens WHERE token_hash = ? LIMIT 1`
      )
      .get(hash) ?? null
  )
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

export function revokeRefreshTokenById(userId: number, sessionId: number): boolean {
  const db = getUpdatesDb()
  const now = new Date().toISOString()
  const result = db.run(
    `UPDATE admin_refresh_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    [now, sessionId, userId]
  )
  return result.changes > 0
}

export function revokeAllUserTokens(userId: number): number {
  const db = getUpdatesDb()
  const now = new Date().toISOString()
  const result = db.run(
    `UPDATE admin_refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
    [now, userId]
  )
  return Number(result.changes ?? 0)
}

export type RotateOutcome =
  | { kind: 'ok'; userId: number; refreshToken: RefreshTokenIssuance }
  | { kind: 'invalid' }
  | { kind: 'reused'; userId: number }

export function rotateRefreshToken(
  oldRaw: string,
  meta: { userAgent?: string | null; ip?: string | null } = {}
): RotateOutcome {
  const row = lookupRefreshTokenRow(oldRaw)
  if (!row) return { kind: 'invalid' }

  if (row.revoked_at) {
    // Reuse of a revoked token signals theft: revoke every active session for this user.
    revokeAllUserTokens(row.user_id)
    return { kind: 'reused', userId: row.user_id }
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { kind: 'invalid' }
  }

  revokeRefreshToken(oldRaw)
  const refreshToken = issueRefreshToken(row.user_id, meta)
  return { kind: 'ok', userId: row.user_id, refreshToken }
}

export function listActiveSessions(userId: number): ActiveSession[] {
  const db = getUpdatesDb()
  const now = new Date().toISOString()
  return db
    .query<RefreshTokenRow, [number, string]>(
      `SELECT * FROM admin_refresh_tokens
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`
    )
    .all(userId, now)
    .map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      userAgent: row.user_agent,
      ip: row.ip,
    }))
}
