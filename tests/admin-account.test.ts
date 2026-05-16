import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { closeDb, initSchema } from '../src/db'
import { createEmptySnapshot, writeReleaseManifest } from '../src/storage'
import { writeReleaseSnapshotToDb } from '../scripts/release/lib'
import adminRoutes from '../src/admin/routes'
import { listRecentAuthEvents } from '../src/admin/audit'
import { listActiveSessions } from '../src/admin/refresh-tokens'
import { findAdminUserByEmail } from '../src/admin/users'
import { resetRateLimiterForTesting } from '../src/admin/rate-limit'
import {
  clearTestAuthEnv,
  seedTestAdmin,
  setTestAuthEnv,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
} from './helpers/admin-auth'

let tempDir = ''
let app: { fetch: (request: Request) => Promise<Response> }

async function request(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init))
}

async function loginWithCredentials(email: string, password: string): Promise<{
  status: number
  cookies: string[]
  cookieHeader: string
  refreshCookie: string | null
}> {
  resetRateLimiterForTesting()
  const res = await request('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password, next: '/admin' }).toString(),
  })
  const cookies = res.headers.getSetCookie?.() ?? []
  const cookieHeader = cookies.map((entry) => entry.split(';')[0]).join('; ')
  const refreshCookie =
    cookies.find((entry) => entry.startsWith('yori_admin_refresh='))?.split(';')[0] ?? null
  return { status: res.status, cookies, cookieHeader, refreshCookie }
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'yori-admin-account-'))
  const releaseDbPath = join(tempDir, 'release.sqlite')
  const updatesDbPath = join(tempDir, 'updates.sqlite')
  const manifestPath = join(tempDir, 'manifest.json')

  writeReleaseSnapshotToDb(releaseDbPath, createEmptySnapshot())
  writeReleaseManifest('account-test-release', {
    version: 'account-test-release',
    builtAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    baseSourceFingerprint: 'account-test',
    releaseDbPath,
    promotedFromUpdateSequence: null,
  })

  process.env.RELEASE_DB_PATH = releaseDbPath
  process.env.RELEASE_VERSION = 'account-test-release'
  process.env.RELEASE_MANIFEST_PATH = manifestPath
  process.env.UPDATES_DATABASE_PATH = updatesDbPath
  setTestAuthEnv()

  const hono = new Hono()
  initSchema()
  hono.route('/', adminRoutes)
  app = { fetch: hono.fetch }

  await seedTestAdmin()
})

afterAll(() => {
  closeDb()
  delete process.env.RELEASE_DB_PATH
  delete process.env.RELEASE_VERSION
  delete process.env.RELEASE_MANIFEST_PATH
  delete process.env.UPDATES_DATABASE_PATH
  clearTestAuthEnv()
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

describe('admin account features', () => {
  test('successful login records auth.login_success event', async () => {
    const { status } = await loginWithCredentials(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    expect(status).toBe(303)
    const events = listRecentAuthEvents(5)
    expect(events.some((e) => e.action === 'auth.login_success' && e.actor === TEST_ADMIN_EMAIL)).toBe(true)
  })

  test('failed login records auth.login_failure event', async () => {
    const { status } = await loginWithCredentials(TEST_ADMIN_EMAIL, 'totally-wrong')
    expect(status).toBe(401)
    const events = listRecentAuthEvents(5)
    expect(events.some((e) => e.action === 'auth.login_failure')).toBe(true)
  })

  test('reusing a revoked refresh token revokes all active sessions for that user', async () => {
    // Two logins → two refresh tokens
    const first = await loginWithCredentials(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const second = await loginWithCredentials(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    expect(first.refreshCookie).not.toBeNull()
    expect(second.refreshCookie).not.toBeNull()

    const user = findAdminUserByEmail(TEST_ADMIN_EMAIL)!
    expect(listActiveSessions(user.id).length).toBeGreaterThanOrEqual(2)

    // Rotate (and thus revoke) the first refresh token
    const refreshRes = await request('/admin/auth/refresh', {
      method: 'POST',
      headers: { cookie: first.refreshCookie! },
    })
    expect(refreshRes.status).toBe(200)

    // Replay the original (now-revoked) refresh token — must wipe all sessions
    const reusedRes = await request('/admin/auth/refresh', {
      method: 'POST',
      headers: { cookie: first.refreshCookie! },
    })
    expect(reusedRes.status).toBe(401)

    expect(listActiveSessions(user.id).length).toBe(0)
    const events = listRecentAuthEvents(10)
    expect(events.some((e) => e.action === 'auth.refresh_reuse_detected')).toBe(true)
  })

  test('account page renders profile and active sessions', async () => {
    const login = await loginWithCredentials(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const accountRes = await request('/admin/account', { headers: { cookie: login.cookieHeader } })
    expect(accountRes.status).toBe(200)
    const html = await accountRes.text()
    expect(html).toContain(TEST_ADMIN_EMAIL)
    expect(html).toContain('Change password')
    expect(html).toContain('Active sessions')
  })

  test('change-password endpoint rejects wrong current password', async () => {
    const login = await loginWithCredentials(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const res = await request('/admin/account/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: login.cookieHeader },
      body: new URLSearchParams({
        currentPassword: 'this-is-wrong',
        newPassword: 'new-password-1234',
        confirmPassword: 'new-password-1234',
      }).toString(),
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Current password is incorrect')
  })

  test('change-password rejects short new password', async () => {
    const login = await loginWithCredentials(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const res = await request('/admin/account/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: login.cookieHeader },
      body: new URLSearchParams({
        currentPassword: TEST_ADMIN_PASSWORD,
        newPassword: 'short',
        confirmPassword: 'short',
      }).toString(),
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('at least 12 characters')
  })

  test('change-password updates hash, revokes sessions, and audits the event', async () => {
    const newPassword = 'fresh-new-password-2026'
    const login = await loginWithCredentials(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const user = findAdminUserByEmail(TEST_ADMIN_EMAIL)!
    expect(listActiveSessions(user.id).length).toBeGreaterThan(0)

    const res = await request('/admin/account/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: login.cookieHeader },
      body: new URLSearchParams({
        currentPassword: TEST_ADMIN_PASSWORD,
        newPassword,
        confirmPassword: newPassword,
      }).toString(),
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('/admin/login')

    // All sessions revoked
    expect(listActiveSessions(user.id).length).toBe(0)

    // Old password no longer works
    const oldLogin = await loginWithCredentials(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    expect(oldLogin.status).toBe(401)

    // New password works
    const newLogin = await loginWithCredentials(TEST_ADMIN_EMAIL, newPassword)
    expect(newLogin.status).toBe(303)

    const events = listRecentAuthEvents(10)
    expect(events.some((e) => e.action === 'auth.password_change')).toBe(true)

    // Restore original password so following tests keep working
    const restoreLogin = await loginWithCredentials(TEST_ADMIN_EMAIL, newPassword)
    await request('/admin/account/change-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: restoreLogin.cookieHeader,
      },
      body: new URLSearchParams({
        currentPassword: newPassword,
        newPassword: TEST_ADMIN_PASSWORD,
        confirmPassword: TEST_ADMIN_PASSWORD,
      }).toString(),
    })
  })

  test('revoking a session removes it and records an audit event', async () => {
    await loginWithCredentials(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const acting = await loginWithCredentials(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const user = findAdminUserByEmail(TEST_ADMIN_EMAIL)!
    const sessions = listActiveSessions(user.id)
    expect(sessions.length).toBeGreaterThanOrEqual(2)

    // Revoke the oldest active session (last in DESC-ordered list)
    const sessionToKill = sessions[sessions.length - 1].id
    const revokeRes = await request(`/admin/account/sessions/${sessionToKill}/revoke`, {
      method: 'POST',
      headers: { cookie: acting.cookieHeader },
    })
    expect(revokeRes.status).toBe(200)

    expect(listActiveSessions(user.id).find((s) => s.id === sessionToKill)).toBeUndefined()
    const events = listRecentAuthEvents(10)
    expect(events.some((e) => e.action === 'auth.session_revoke')).toBe(true)
  })
})
