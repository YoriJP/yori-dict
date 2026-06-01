# Auth Improvement Plan for yori-dict (Strapi-Style)

## Context

The admin console currently authenticates with a single shared `ADMIN_TOKEN` env var (plaintext). We're moving to a **Strapi-style auth system**: admin accounts in the database, email + password login, bcrypt-hashed passwords, JWT-based sessions with refresh tokens.

This is heavier than strictly necessary for a single-admin tool, but follows a well-understood industry pattern, scales to multiple admins later, and keeps no plaintext credentials on disk.

---

## Target Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                          Browser                              │
│   Email/Password form  →  HttpOnly cookies (access + refresh) │
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                    /admin/login (POST)                        │
│   1. Look up admin_users by email                             │
│   2. bcrypt.compare(input, stored_hash)                       │
│   3. On success: issue JWT (15m) + refresh token (30d)        │
│   4. Set HttpOnly cookies                                     │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                   /admin/api/* (protected)                    │
│   Middleware: verify JWT signature + exp                      │
│   On expired: client calls /admin/auth/refresh                │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                  /admin/auth/refresh (POST)                   │
│   1. Read refresh token from cookie                           │
│   2. Look up in admin_refresh_tokens (must be unrevoked)      │
│   3. Issue new JWT, optionally rotate refresh token           │
└──────────────────────────────────────────────────────────────┘
```

---

## Database Schema

Two new tables in the existing SQLite database (`src/db.ts`):

```sql
CREATE TABLE admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE admin_refresh_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,        -- sha256 of the actual token (we never store the raw token)
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);

CREATE INDEX idx_refresh_tokens_user ON admin_refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON admin_refresh_tokens(token_hash);
```

---

## Implementation Phases

### Phase A — Foundation (4–6 hours)

**Goal:** DB-backed users, bcrypt passwords, JWT sessions. Replace the current token entirely.

#### 1. Dependencies
```bash
bun add jose bcrypt
bun add -d @types/bcrypt
```

- `jose` — modern JWT library, supports HS256/RS256, type-safe
- `bcrypt` — password hashing (cost factor 12)

#### 2. Database setup
- Add migration in `src/db.ts` (or wherever schema is initialized) for the two tables above
- Add a `init-admin-schema.ts` if migrations are separate

#### 3. Admin user model (`src/admin/users.ts` — new file)
```ts
export function createAdminUser(email: string, password: string): AdminUser
export function findAdminUserByEmail(email: string): AdminUser | null
export function updateLastLogin(userId: number): void
export function verifyPassword(plain: string, hash: string): Promise<boolean>
export function hashPassword(plain: string): Promise<string>  // bcrypt cost 12
```

#### 4. JWT utilities (`src/admin/jwt.ts` — new file)
```ts
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!)

export async function signAccessToken(userId: number, email: string): Promise<string>
  // { sub: userId, email, type: 'access' }, exp: now + 15min, HS256

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null>

export function generateRefreshToken(): { raw: string; hash: string }
  // raw: 32-byte base64url random; hash: sha256(raw) stored in DB
```

#### 5. Refresh token store (`src/admin/refresh-tokens.ts` — new file)
```ts
export function storeRefreshToken(userId: number, rawToken: string, ttlDays: number, meta: { ip?: string; ua?: string }): void
export function validateRefreshToken(rawToken: string): { userId: number } | null
export function revokeRefreshToken(rawToken: string): void
export function revokeAllUserTokens(userId: number): void
```

Store only the SHA-256 hash of the refresh token in DB — the raw value lives only in the user's cookie. A DB leak doesn't expose usable tokens.

#### 6. Replace `src/admin/auth.ts`

Strip out the old HMAC cookie scheme. New shape:

```ts
export async function login(email: string, password: string): Promise<LoginResult | null>
  // returns { user, accessToken, refreshToken } or null

export async function refreshSession(refreshToken: string): Promise<RefreshResult | null>

export async function logout(refreshToken: string): Promise<void>

export const requireAdminAuth: MiddlewareHandler
  // Reads access_token cookie, verifies, sets c.set('adminUser', user)

export const requireAdminPageAuth: MiddlewareHandler
  // Same as above but redirects to /admin/login on failure
```

#### 7. Cookie strategy

Two HttpOnly cookies:

| Cookie | Contents | Max-Age | Path |
|---|---|---|---|
| `yori_admin_access` | JWT (HS256) | 15 min | `/admin` |
| `yori_admin_refresh` | Opaque random token | 30 days | `/admin/auth` |

Both: `HttpOnly`, `SameSite=Lax`, `Secure` (always — assume HTTPS-only deploy).

#### 8. Routes (`src/admin/routes.ts`)

```
POST /admin/login           — email + password → set cookies → redirect to next
POST /admin/auth/refresh    — refresh cookie → new access cookie (rotate refresh)
POST /admin/logout          — revoke refresh in DB, clear both cookies
```

#### 9. Login form (`src/admin/views.ts`)

- Two fields: Email, Password
- Show errors inline (generic message: "Invalid credentials")
- Keep the existing styling

#### 10. CLI: create the first admin

`scripts/admin/create-user.ts` — interactive prompt for email + password, validates strength, hashes with bcrypt, inserts into DB.

```bash
bun run scripts/admin/create-user.ts
# prompts: Email? Password? Confirm password?
# inserts row, prints "Admin user created: anila@example.com"
```

#### 11. Env vars (`.env`)

Remove:
- `ADMIN_TOKEN`

Add:
- `JWT_SECRET` — 32+ bytes random, generated via `openssl rand -base64 32`

#### 12. Rate limiting on `/admin/login`

In-memory rate limiter, max 5 failed attempts per IP per 15 minutes. Return 429 with `Retry-After` on exceeded.

#### 13. Tests (`tests/admin.test.ts`)

Rewrite the auth section:
- `create user → login → verify access cookie set`
- `protected route with valid access cookie → 200`
- `protected route with expired/invalid JWT → 401`
- `refresh endpoint with valid refresh token → new access cookie`
- `refresh endpoint with revoked token → 401`
- `logout revokes refresh token and clears cookies`
- `5 failed login attempts → 6th returns 429`
- `wrong email returns same error as wrong password` (no user enumeration)

---

### Phase B — Hardening (1–2 hours)

**Add after Phase A is stable.**

1. **Audit log**
   - New table `admin_audit_log(id, user_id, action, resource, ip, ua, created_at, metadata_json)`
   - Log: login success, login failure, logout, every state-changing admin API call (approve, reject, build, promote)
   - Add helper `logAdminAction(c, action, resource?, metadata?)` called from each mutating endpoint

2. **Refresh token rotation**
   - On each `/admin/auth/refresh` call, revoke the old refresh token and issue a new one
   - Detects token reuse → if a revoked token is used, revoke *all* tokens for that user (someone stole one)

3. **Password change endpoint**
   - `POST /admin/account/change-password` requires current password, verifies, updates hash, revokes all refresh tokens (force re-login)

4. **Session list / revoke**
   - Admin UI page showing active sessions (refresh tokens) with IP/UA/created-at
   - "Revoke" button per session

---

### Phase C — Optional Future Work

Not part of the initial implementation, but the architecture supports these naturally:

- **Multi-admin support** — already supported by schema, just add a user-management UI
- **RBAC** — add `role` column to `admin_users`, scopes in JWT payload
- **Password reset via email** — needs an email-sending integration (Resend, SES, Postmark)
- **MFA (TOTP)** — add `totp_secret` column, verify TOTP on login

---

## File Changes Summary

### New files
- `src/admin/users.ts` — user CRUD + bcrypt
- `src/admin/jwt.ts` — JWT sign/verify with `jose`
- `src/admin/refresh-tokens.ts` — refresh token store
- `src/admin/rate-limit.ts` — in-memory rate limiter
- `src/admin/audit.ts` — audit log helpers (Phase B)
- `scripts/admin/create-user.ts` — CLI to create admin
- `scripts/admin/change-password.ts` — CLI to reset password (break-glass)

### Modified files
- `src/db.ts` (or schema init) — add `admin_users`, `admin_refresh_tokens`, `admin_audit_log` tables
- `src/admin/auth.ts` — replace HMAC cookie scheme with JWT-based middleware
- `src/admin/routes.ts` — new `/admin/auth/refresh`, updated `/admin/login` + `/admin/logout`
- `src/admin/views.ts` — login form gains Email field
- `.env` / `.env.example` — remove `ADMIN_TOKEN`, add `JWT_SECRET`
- `tests/admin.test.ts` — rewrite auth tests
- `package.json` — add `jose`, `bcrypt`, `@types/bcrypt`
- `docs/admin-operations-manual.md` — document user-creation CLI

### Removed (effectively)
- Old HMAC cookie scheme in `src/admin/auth.ts`
- `ADMIN_TOKEN` env var

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Password hash | **bcrypt cost 12** | Industry standard, well-tested. argon2id is newer but bcrypt is fine. |
| JWT algorithm | **HS256** | Single service, symmetric key is simpler than RS256. Switch to RS256 if you ever distribute verification. |
| Access token lifetime | **15 minutes** | Short enough that leaks have limited window. Refresh covers UX. |
| Refresh token lifetime | **30 days** | Standard. User re-logs in monthly. |
| Token storage | **HttpOnly cookies** | Strapi puts JWT in localStorage; cookies are safer (XSS-proof). |
| Refresh token format | **Opaque random + DB lookup** | Allows revocation. JWT refresh tokens can't be revoked. |
| User enumeration | **Generic "Invalid credentials" error** | Don't leak whether the email exists. |
| Rate limiting | **In-memory per-IP** | Single instance deploy; if you ever go multi-instance, swap for Redis. |

---

## Verification

After Phase A:

```bash
# 1. Initialize DB and create first admin
bun run scripts/admin/create-user.ts
# Enter: anila@example.com / your-password

# 2. Start server
JWT_SECRET=$(openssl rand -base64 32) bun run dev

# 3. Manual smoke test
# - Visit /admin → redirected to /admin/login
# - Submit form with email + password → redirected to /admin, cookies set
# - Reload /admin after 15+ min → access token expired, refresh fires silently
# - POST /admin/logout → cookies cleared, redirected to /admin/login

# 4. Run tests
bun test tests/admin.test.ts

# 5. Try attacks
# - 6 failed logins → 429 returned
# - Tampered JWT → 401
# - Revoked refresh token → 401
# - Wrong email shows same error as wrong password (timing-safe)
```

---

## Recommended Order of Work

1. **Schema + dependencies** — get the DB tables and libraries in place
2. **users.ts + create-user.ts CLI** — be able to create an admin row
3. **jwt.ts + refresh-tokens.ts** — core token plumbing
4. **auth.ts middleware** — JWT verification middleware
5. **routes.ts** — login, logout, refresh endpoints
6. **views.ts** — update form
7. **Rate limiting** — wrap login route
8. **Tests** — rewrite admin.test.ts
9. **Remove `ADMIN_TOKEN`** — clean up old code
10. **Phase B** when ready

Each step is independently verifiable. Don't bundle them into one giant PR — ship Phase A as 3–4 smaller PRs if possible.
