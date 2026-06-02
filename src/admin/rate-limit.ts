interface AttemptRecord {
  count: number
  resetAt: number
}

const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 5

const attempts = new Map<string, AttemptRecord>()

export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
}

export function checkLoginRate(key: string): RateLimitResult {
  const now = Date.now()
  const record = attempts.get(key)

  if (!record || record.resetAt <= now) {
    return { allowed: true, retryAfterSeconds: 0 }
  }

  if (record.count >= MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
    }
  }

  return { allowed: true, retryAfterSeconds: 0 }
}

export function recordLoginFailure(key: string): void {
  const now = Date.now()
  const record = attempts.get(key)

  if (!record || record.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return
  }

  record.count += 1
}

export function clearLoginAttempts(key: string): void {
  attempts.delete(key)
}

export function resetRateLimiterForTesting(): void {
  attempts.clear()
}
