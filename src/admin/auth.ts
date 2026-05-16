import { createHmac, timingSafeEqual } from 'crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { renderAdminLoginPage } from './views'

const ADMIN_SESSION_COOKIE = 'yori_admin_session'
const ADMIN_SESSION_MARKER = 'v1'

function getAdminToken(): string | null {
  const token = process.env.ADMIN_TOKEN?.trim()
  return token ? token : null
}

function safeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function signSessionMarker(token: string, marker: string): string {
  return createHmac('sha256', token)
    .update(marker)
    .digest('base64url')
}

function buildSessionCookieValue(token: string): string {
  return `${ADMIN_SESSION_MARKER}.${signSessionMarker(token, ADMIN_SESSION_MARKER)}`
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
      // Ignore malformed cookie encoding so unrelated client state cannot break auth.
      cookies.set(name, rawValue)
    }
  }
  return cookies
}

function buildCookieHeader(name: string, value: string, options: {
  maxAge?: number
  expires?: string
} = {}): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/admin',
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

function jsonUnauthorized(c: Context): Response {
  c.header('WWW-Authenticate', 'Basic realm="Yori Admin"')
  return c.json({ error: 'Unauthorized' }, 401)
}

function adminDisabledJson(c: Context): Response {
  return c.json({ error: 'Admin UI is disabled. Set ADMIN_TOKEN to enable /admin routes.' }, 503)
}

function matchesBearerToken(authHeader: string, token: string): boolean {
  const [scheme, value] = authHeader.split(/\s+/, 2)
  return scheme?.toLowerCase() === 'bearer' && safeEqualText(value ?? '', token)
}

function matchesBasicToken(authHeader: string, token: string): boolean {
  const [scheme, value] = authHeader.split(/\s+/, 2)
  if (scheme?.toLowerCase() !== 'basic' || !value) return false

  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    if (separator < 0) return false
    const password = decoded.slice(separator + 1)
    return safeEqualText(password, token)
  } catch {
    return false
  }
}

function matchesHeaderToken(c: Context, token: string): boolean {
  const authHeader = c.req.header('authorization') ?? ''
  const headerToken = c.req.header('x-admin-token') ?? ''
  return (
    safeEqualText(headerToken, token) ||
    matchesBearerToken(authHeader, token) ||
    matchesBasicToken(authHeader, token)
  )
}

function matchesSessionCookie(c: Context, token: string): boolean {
  const cookieHeader = c.req.header('cookie') ?? ''
  const cookieValue = parseCookies(cookieHeader).get(ADMIN_SESSION_COOKIE)
  if (!cookieValue) return false

  const [marker, signature] = cookieValue.split('.', 2)
  if (marker !== ADMIN_SESSION_MARKER || !signature) return false

  return safeEqualText(signature, signSessionMarker(token, marker))
}

function isAuthorized(c: Context, token: string): boolean {
  return matchesHeaderToken(c, token) || matchesSessionCookie(c, token)
}

function getRedirectTarget(c: Context): string {
  const url = new URL(c.req.url)
  const candidate = url.pathname + url.search
  return normalizeAdminNextPath(candidate)
}

export function normalizeAdminNextPath(raw: string | null | undefined): string {
  if (!raw) return '/admin'
  if (!raw.startsWith('/admin')) return '/admin'
  if (raw.startsWith('//')) return '/admin'
  if (raw.startsWith('/admin/login') || raw.startsWith('/admin/logout')) return '/admin'
  return raw
}

export function isAdminEnabled(): boolean {
  return getAdminToken() !== null
}

export function getAdminActor(c: Context): string {
  const authHeader = c.req.header('authorization') ?? ''
  if (authHeader.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(authHeader.split(/\s+/, 2)[1] ?? '', 'base64').toString('utf8')
      const separator = decoded.indexOf(':')
      const username = separator >= 0 ? decoded.slice(0, separator) : 'admin'
      return username || 'admin'
    } catch {
      return 'admin'
    }
  }
  return 'admin'
}

export function verifyAdminPassword(password: string): boolean {
  const token = getAdminToken()
  return token ? safeEqualText(password, token) : false
}

export function isAdminAuthenticated(c: Context): boolean {
  const token = getAdminToken()
  return token ? isAuthorized(c, token) : false
}

export function setAdminSessionCookie(c: Context): void {
  const token = getAdminToken()
  if (!token) return
  c.header('Set-Cookie', buildCookieHeader(ADMIN_SESSION_COOKIE, buildSessionCookieValue(token)))
}

export function clearAdminSessionCookie(c: Context): void {
  c.header(
    'Set-Cookie',
    buildCookieHeader(ADMIN_SESSION_COOKIE, '', {
      maxAge: 0,
      expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
    })
  )
}

export const requireAdminApiAuth: MiddlewareHandler = async (c, next) => {
  const token = getAdminToken()
  if (!token) return adminDisabledJson(c)
  if (!isAuthorized(c, token)) return jsonUnauthorized(c)

  await next()
}

export const requireAdminPageAuth: MiddlewareHandler = async (c, next) => {
  const token = getAdminToken()
  if (!token) {
    return c.html(renderAdminLoginPage({
      disabled: true,
      next: getRedirectTarget(c),
    }), 503)
  }

  if (!isAuthorized(c, token)) {
    const loginUrl = new URL('/admin/login', c.req.url)
    loginUrl.searchParams.set('next', getRedirectTarget(c))
    return c.redirect(loginUrl.pathname + loginUrl.search, 302)
  }

  await next()
}
