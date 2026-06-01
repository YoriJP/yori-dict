import { getUpdatesDb } from '../db'
import { recordAdminAction } from '../update-store'

export type AuthEventKind =
  | 'auth.login_success'
  | 'auth.login_failure'
  | 'auth.logout'
  | 'auth.refresh'
  | 'auth.refresh_reuse_detected'
  | 'auth.password_change'
  | 'auth.session_revoke'

interface AuthEventInput {
  kind: AuthEventKind
  actor: string
  targetId?: string
  ip?: string | null
  userAgent?: string | null
  extra?: Record<string, unknown>
}

function buildNotes(input: AuthEventInput): string | null {
  const payload: Record<string, unknown> = {}
  if (input.ip) payload.ip = input.ip
  if (input.userAgent) payload.ua = input.userAgent
  if (input.extra) Object.assign(payload, input.extra)
  if (Object.keys(payload).length === 0) return null
  return JSON.stringify(payload)
}

export function recordAuthEvent(input: AuthEventInput): void {
  const db = getUpdatesDb()
  recordAdminAction(db, {
    actor: input.actor,
    action: input.kind,
    targetKind: 'auth',
    targetId: input.targetId ?? input.actor,
    notes: buildNotes(input),
  })
}

interface AuthAuditRow {
  id: number
  actor: string
  action: string
  target_kind: string
  target_id: string
  notes: string | null
  created_at: string
}

export interface AuthAuditEntry {
  id: number
  actor: string
  action: AuthEventKind
  targetId: string
  notes: Record<string, unknown> | null
  createdAt: string
}

export function listRecentAuthEvents(limit = 50): AuthAuditEntry[] {
  const db = getUpdatesDb()
  return db
    .query<AuthAuditRow, [number]>(
      `SELECT * FROM admin_actions
       WHERE target_kind = 'auth'
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit)
    .map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action as AuthEventKind,
      targetId: row.target_id,
      notes: row.notes ? safeParseJson(row.notes) : null,
      createdAt: row.created_at,
    }))
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
