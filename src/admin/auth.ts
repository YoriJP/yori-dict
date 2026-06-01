import type { Context, MiddlewareHandler } from 'hono'

declare module 'hono' {
  interface ContextVariableMap {
    adminUser: import('./users').AdminUser
  }
}
import { renderAdminLoginPage } from './views'
import {
  findAdminUserById,
  findAdminUserByEmail,
  updateAdminPassword,
  updateLastLogin,
  verifyPassword,
} from './users'
import type { AdminUser } from './users'
import {
  ACCESS_TOKEN_MAX_AGE,
  REFRESH_TOKEN_MAX_AGE,
  isJwtConfigured,
  signAccessToken,
  verifyAccessToken,
} from './jwt'
import {
  issueRefreshToken,
  revokeAllUserTokens,
  revokeRefreshToken,
  revokeRefreshTokenById,
  rotateRefreshToken,
} from './refresh-tokens'
import { recordAuthEvent } from './audit'

export const ADMIN_ACCESS_COOKIE = 'yori_admin_access'
export const ADMIN_REFRESH_COOKIE = 'yori_admin_refresh'

const ACCESS_COOKIE_PATH = '/admin'
const REFRESH_COOKIE_PATH = '/admin/auth'

export interface LoginResult {
  user: AdminUser
  accessToken: string
  refreshToken: string
}

export interface RefreshResult {
  user: AdminUser
  accessToken: string
  refreshToken: string
}

function parseCookies(header: string): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const pair of header.split(';')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('=')
    if (separator < 0) continue
    const name = trimmed.slice(0, separator)
    const rawValue = trimmed.slice(separator + 1)
    try {
      cookies.set(name, decodeURIComponent(rawValue))
    } catch {
      cookies.set(name, rawValue)
    }
  }
  return cookies
}

function buildCookieHeader(
  name: string,
  value: string,
  options: { path: string; maxAge?: number; expires?: string }
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (process.env.NODE_ENV === 'production') {
    parts.push('Secure')
  }
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  if (options.expires) parts.push(`Expires=${options.expires}`)
  return parts.join('; ')
}

function appendSetCookie(c: Context, header: string): void {
  const existing = c.res.headers.get('set-cookie')
  if (existing) {
    c.res.headers.append('set-cookie', header)
  } else {
    c.header('set-cookie', header)
  }
}

export function setAuthCookies(c: Context, accessToken: string, refreshToken: string): void {
  appendSetCookie(
    c,
    buildCookieHeader(ADMIN_ACCESS_COOKIE, accessToken, {
      path: ACCESS_COOKIE_PATH,
      maxAge: ACCESS_TOKEN_MAX_AGE,
    })
  )
  appendSetCookie(
    c,
    buildCookieHeader(ADMIN_REFRESH_COOKIE, refreshToken, {
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_TOKEN_MAX_AGE,
    })
  )
}

export function clearAuthCookies(c: Context): void {
  const expired = 'Thu, 01 Jan 1970 00:00:00 GMT'
  appendSetCookie(
    c,
    buildCookieHeader(ADMIN_ACCESS_COOKIE, '', {
      path: ACCESS_COOKIE_PATH,
      maxAge: 0,
      expires: expired,
    })
  )
  appendSetCookie(
    c,
    buildCookieHeader(ADMIN_REFRESH_COOKIE, '', {
      path: REFRESH_COOKIE_PATH,
      maxAge: 0,
      expires: expired,
    })
  )
}

export function readAccessTokenCookie(c: Context): string | null {
  const cookieHeader = c.req.header('cookie') ?? ''
  return parseCookies(cookieHeader).get(ADMIN_ACCESS_COOKIE) ?? null
}

export function readRefreshTokenCookie(c: Context): string | null {
  const cookieHeader = c.req.header('cookie') ?? ''
  return parseCookies(cookieHeader).get(ADMIN_REFRESH_COOKIE) ?? null
}

export function isAdminEnabled(): boolean {
  return isJwtConfigured()
}

export async function attemptLogin(
  email: string,
  password: string,
  meta: { userAgent?: string | null; ip?: string | null } = {}
): Promise<LoginResult | null> {
  const user = findAdminUserByEmail(email)
  if (!user || !user.isActive) {
    await verifyPassword(password, '$2b$12$0000000000000000000000000000000000000000000000000000')
    recordAuthEvent({
      kind: 'auth.login_failure',
      actor: email || 'unknown',
      targetId: email || 'unknown',
      ip: meta.ip,
      userAgent: meta.userAgent,
      extra: { reason: 'unknown_user_or_inactive' },
    })
    return null
  }
  const ok = await verifyPassword(password, user.passwordHash)
  if (!ok) {
    recordAuthEvent({
      kind: 'auth.login_failure',
      actor: user.email,
      targetId: String(user.id),
      ip: meta.ip,
      userAgent: meta.userAgent,
      extra: { reason: 'wrong_password' },
    })
    return null
  }

  updateLastLogin(user.id)
  const accessToken = await signAccessToken(user.id, user.email)
  const refresh = issueRefreshToken(user.id, meta)
  recordAuthEvent({
    kind: 'auth.login_success',
    actor: user.email,
    targetId: String(user.id),
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
  return { user, accessToken, refreshToken: refresh.raw }
}

export async function refreshSession(
  refreshToken: string,
  meta: { userAgent?: string | null; ip?: string | null } = {}
): Promise<RefreshResult | null> {
  const outcome = rotateRefreshToken(refreshToken, meta)
  if (outcome.kind === 'invalid') return null

  if (outcome.kind === 'reused') {
    const user = findAdminUserById(outcome.userId)
    recordAuthEvent({
      kind: 'auth.refresh_reuse_detected',
      actor: user?.email ?? `user:${outcome.userId}`,
      targetId: String(outcome.userId),
      ip: meta.ip,
      userAgent: meta.userAgent,
      extra: { note: 'all sessions revoked' },
    })
    return null
  }

  const user = findAdminUserById(outcome.userId)
  if (!user || !user.isActive) {
    revokeAllUserTokens(outcome.userId)
    return null
  }
  const accessToken = await signAccessToken(user.id, user.email)
  recordAuthEvent({
    kind: 'auth.refresh',
    actor: user.email,
    targetId: String(user.id),
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
  return { user, accessToken, refreshToken: outcome.refreshToken.raw }
}

export function logout(
  refreshToken: string | null,
  meta: { actor?: string; ip?: string | null; userAgent?: string | null } = {}
): void {
  if (refreshToken) revokeRefreshToken(refreshToken)
  if (meta.actor) {
    recordAuthEvent({
      kind: 'auth.logout',
      actor: meta.actor,
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
  }
}

export async function changeAdminPassword(
  user: AdminUser,
  currentPassword: string,
  newPassword: string,
  meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<{ ok: true } | { ok: false; reason: 'wrong_current' | 'weak_new' }> {
  const currentOk = await verifyPassword(currentPassword, user.passwordHash)
  if (!currentOk) {
    recordAuthEvent({
      kind: 'auth.login_failure',
      actor: user.email,
      targetId: String(user.id),
      ip: meta.ip,
      userAgent: meta.userAgent,
      extra: { reason: 'password_change_wrong_current' },
    })
    return { ok: false, reason: 'wrong_current' }
  }
  if (newPassword.length < 12) {
    return { ok: false, reason: 'weak_new' }
  }
  await updateAdminPassword(user.id, newPassword)
  revokeAllUserTokens(user.id)
  recordAuthEvent({
    kind: 'auth.password_change',
    actor: user.email,
    targetId: String(user.id),
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
  return { ok: true }
}

export function revokeSessionForUser(
  user: AdminUser,
  sessionId: number,
  meta: { ip?: string | null; userAgent?: string | null } = {}
): boolean {
  const ok = revokeRefreshTokenById(user.id, sessionId)
  if (ok) {
    recordAuthEvent({
      kind: 'auth.session_revoke',
      actor: user.email,
      targetId: String(sessionId),
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
  }
  return ok
}

export async function getAuthenticatedUser(c: Context): Promise<AdminUser | null> {
  const token = readAccessTokenCookie(c)
  if (!token) return null
  const payload = await verifyAccessToken(token)
  if (!payload) return null
  const user = findAdminUserById(Number(payload.sub))
  if (!user || !user.isActive) return null
  return user
}

export function getAdminActor(c: Context): string {
  const user = (c.get('adminUser') as AdminUser | undefined) ?? null
  return user?.email ?? 'admin'
}

function getRedirectTarget(c: Context): string {
  const url = new URL(c.req.url)
  return normalizeAdminNextPath(url.pathname + url.search)
}

export function normalizeAdminNextPath(raw: string | null | undefined): string {
  if (!raw) return '/admin'
  if (!raw.startsWith('/admin')) return '/admin'
  if (raw.startsWith('//')) return '/admin'
  if (raw.startsWith('/admin/login') || raw.startsWith('/admin/logout') || raw.startsWith('/admin/auth')) {
    return '/admin'
  }
  return raw
}

function jsonUnauthorized(c: Context): Response {
  return c.json({ error: 'Unauthorized' }, 401)
}

function adminDisabledJson(c: Context): Response {
  return c.json(
    { error: 'Admin UI is disabled. Set JWT_SECRET and create an admin user to enable /admin routes.' },
    503
  )
}

export const requireAdminApiAuth: MiddlewareHandler = async (c, next) => {
  if (!isAdminEnabled()) return adminDisabledJson(c)
  const user = await getAuthenticatedUser(c)
  if (!user) return jsonUnauthorized(c)
  c.set('adminUser', user)
  await next()
}

export const requireAdminPageAuth: MiddlewareHandler = async (c, next) => {
  if (!isAdminEnabled()) {
    return c.html(
      renderAdminLoginPage({
        disabled: true,
        next: getRedirectTarget(c),
      }),
      503
    )
  }
  const user = await getAuthenticatedUser(c)
  if (!user) {
    const loginUrl = new URL('/admin/login', c.req.url)
    loginUrl.searchParams.set('next', getRedirectTarget(c))
    return c.redirect(loginUrl.pathname + loginUrl.search, 302)
  }
  c.set('adminUser', user)
  await next()
}
