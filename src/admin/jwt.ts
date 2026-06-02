import { createHash, randomBytes } from 'crypto'
import { SignJWT, jwtVerify } from 'jose'

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
const REFRESH_TOKEN_TTL_DAYS = 30

export interface AccessTokenPayload {
  sub: string
  email: string
  type: 'access'
  iat: number
  exp: number
}

let cachedSecret: Uint8Array | null = null
let cachedSecretSource: string | null = null

function getJwtSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET?.trim()
  if (!raw) throw new Error('JWT_SECRET is not configured')
  if (raw.length < 32) throw new Error('JWT_SECRET must be at least 32 characters')
  if (cachedSecret && cachedSecretSource === raw) return cachedSecret
  cachedSecret = new TextEncoder().encode(raw)
  cachedSecretSource = raw
  return cachedSecret
}

export function isJwtConfigured(): boolean {
  const raw = process.env.JWT_SECRET?.trim()
  return !!raw && raw.length >= 32
}

export async function signAccessToken(userId: number, email: string): Promise<string> {
  return new SignJWT({ email, type: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getJwtSecret())
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), { algorithms: ['HS256'] })
    if (payload.type !== 'access' || typeof payload.sub !== 'string') return null
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      type: 'access',
      iat: typeof payload.iat === 'number' ? payload.iat : 0,
      exp: typeof payload.exp === 'number' ? payload.exp : 0,
    }
  } catch {
    return null
  }
}

export function generateRefreshToken(): { raw: string; hash: string; expiresAt: string } {
  const raw = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(raw).digest('hex')
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
  return { raw, hash, expiresAt }
}

export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export const ACCESS_TOKEN_MAX_AGE = ACCESS_TOKEN_TTL_SECONDS
export const REFRESH_TOKEN_MAX_AGE = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60
