import { createAdminUser } from '../../src/admin/users'
import { resetRateLimiterForTesting } from '../../src/admin/rate-limit'

export const TEST_ADMIN_EMAIL = 'admin@yori.test'
export const TEST_ADMIN_PASSWORD = 'correct-horse-battery-staple'
export const TEST_JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-bytes-long-please-yes'

export function setTestAuthEnv(): void {
  process.env.JWT_SECRET = TEST_JWT_SECRET
  process.env.ADMIN_PASSWORD_BCRYPT_COST = '4'
}

export function clearTestAuthEnv(): void {
  delete process.env.JWT_SECRET
  delete process.env.ADMIN_PASSWORD_BCRYPT_COST
}

export async function seedTestAdmin(): Promise<void> {
  await createAdminUser(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
}

export interface LoggedInSession {
  cookie: string
}

export async function loginAsTestAdmin(
  app: { fetch: (request: Request) => Response | Promise<Response> }
): Promise<LoggedInSession> {
  resetRateLimiterForTesting()
  const res = await app.fetch(
    new Request('http://localhost/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: TEST_ADMIN_EMAIL,
        password: TEST_ADMIN_PASSWORD,
        next: '/admin',
      }).toString(),
    })
  )
  if (res.status !== 303) {
    throw new Error(`Test login failed with status ${res.status}`)
  }
  const setCookies = res.headers.getSetCookie?.() ?? []
  const cookieHeaders = setCookies.length > 0 ? setCookies : [res.headers.get('set-cookie') ?? '']
  const cookie = cookieHeaders
    .map((header) => header.split(';')[0])
    .filter(Boolean)
    .join('; ')
  if (!cookie) throw new Error('No session cookies returned from test login')
  return { cookie }
}

export function authHeaders(session: LoggedInSession, extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, cookie: session.cookie }
}
