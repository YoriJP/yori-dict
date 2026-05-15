import type { Context, MiddlewareHandler } from 'hono'
import { renderAdminLoginPage } from './views'
import { findAdminUserById, findAdminUserByEmail, updateLastLogin, verifyPassword } from './users'
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
  rotateRefreshToken,
} from './refresh-tokens'

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
    // Run a dummy verify to keep timing consistent (avoid email enumeration)
    await verifyPassword(password, '$2b$12$0000000000000000000000000000000000000000000000000000')
    return null
  }
  const ok = await verifyPassword(password, user.passwordHash)
  if (!ok) return null

  updateLastLogin(user.id)
  const accessToken = await signAccessToken(user.id, user.email)
  const refresh = issueRefreshToken(user.id, meta)
  return { user, accessToken, refreshToken: refresh.raw }
}

export async function refreshSession(
  refreshToken: string,
  meta: { userAgent?: string | null; ip?: string | null } = {}
): Promise<RefreshResult | null> {
  const rotated = rotateRefreshToken(refreshToken, meta)
  if (!rotated) return null
  const user = findAdminUserById(rotated.userId)
  if (!user || !user.isActive) {
    revokeAllUserTokens(rotated.userId)
    return null
  }
  const accessToken = await signAccessToken(user.id, user.email)
  return { user, accessToken, refreshToken: rotated.refreshToken.raw }
}

export function logout(refreshToken: string | null): void {
  if (refreshToken) revokeRefreshToken(refreshToken)
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
