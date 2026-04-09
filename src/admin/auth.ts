import type { Context, MiddlewareHandler } from 'hono'

function unauthorized(c: Context): Response {
  c.header('WWW-Authenticate', 'Basic realm="Yori Admin"')
  return c.json({ error: 'Unauthorized' }, 401)
}

function getAdminToken(): string | null {
  const token = process.env.ADMIN_TOKEN?.trim()
  return token ? token : null
}

export function isAdminEnabled(): boolean {
  return getAdminToken() !== null
}

function matchesBearerToken(authHeader: string, token: string): boolean {
  const [scheme, value] = authHeader.split(/\s+/, 2)
  return scheme.toLowerCase() === 'bearer' && value === token
}

function matchesBasicToken(authHeader: string, token: string): boolean {
  const [scheme, value] = authHeader.split(/\s+/, 2)
  if (scheme.toLowerCase() !== 'basic' || !value) return false

  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    if (separator < 0) return false
    const password = decoded.slice(separator + 1)
    return password === token
  } catch {
    return false
  }
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

export const requireAdminAuth: MiddlewareHandler = async (c, next) => {
  const token = getAdminToken()
  if (!token) {
    return c.json({ error: 'Admin UI is disabled. Set ADMIN_TOKEN to enable /admin routes.' }, 503)
  }

  const authHeader = c.req.header('authorization') ?? ''
  const headerToken = c.req.header('x-admin-token') ?? ''
  if (
    headerToken === token ||
    matchesBearerToken(authHeader, token) ||
    matchesBasicToken(authHeader, token)
  ) {
    await next()
    return
  }

  return unauthorized(c)
}
