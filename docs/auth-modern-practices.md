# Modern Authentication: A Practical Overview (2026)

Authentication has changed more in the last three years than in the previous twenty. Passwords are being replaced, sessions are being rethought, and the question "how should I let users log in?" no longer has a single answer.

This document surveys the modern landscape, explains each approach in plain terms, and gives concrete guidance on when to use what.

---

## 1. The Big Picture

In 2026 there are essentially **four building blocks** in modern auth:

| Block | What it does | Example |
|---|---|---|
| **Identity proof** | Verifies *who* the user is | Password, Passkey, Magic Link, OAuth login |
| **Session mechanism** | Keeps the user logged in across requests | Cookie, JWT, OAuth access token |
| **Authorization layer** | Decides *what* the user can do | RBAC, scopes, claims |
| **Recovery flow** | Restores access when the user gets locked out | Email reset, backup codes, recovery contacts |

Most real systems combine pieces from each block. A well-designed system picks the right combination for its threat model, not the trendiest option.

---

## 2. Identity Proof — How Users Prove Who They Are

### 2.1 Passwords (still everywhere, but on the way out)

**How it works:** User enters a string they remember. Server stores a hash (bcrypt, argon2, or scrypt).

**Why it's losing favor:**
- Users reuse passwords across sites
- Phishing is the #1 attack vector and passwords are uniquely vulnerable to it
- Even strong passwords can be stolen from a leaked database

**If you still use passwords, do this minimum:**
- Hash with **argon2id** or **bcrypt** (cost factor 12+)
- Never log or store plaintext
- Enforce minimum length, not complexity rules (length beats symbols)
- Pair with **MFA** — password alone is no longer acceptable for anything sensitive

### 2.2 Passkeys (the recommended default for 2026)

**How it works:** The user's device generates a public/private key pair, scoped to your domain. The private key never leaves the device. To log in, the device signs a challenge using biometrics (Face ID, fingerprint) or a PIN.

**Why it matters:**
- **Phishing-resistant by design** — the key is domain-bound, so a fake login page on a different domain cannot capture it
- **No shared secret** — no database of password hashes to leak
- **No passwords to remember, reset, or rotate**

**Adoption in 2026:** Major platforms (Apple, Google, Microsoft, GitHub, 1Password) all support passkey sync across devices. Browser support (Chrome 108+, Safari 16+, Edge 108+) and OS support (iOS 16+, Android 9+, macOS Ventura+, Windows 10+) covers the vast majority of users.

**Standards:** Built on **WebAuthn** (W3C) and **FIDO2** (FIDO Alliance). WebAuthn Level 3 published as a Working Draft in early 2025.

**Migration reality:** What used to be a six-month integration is now a 2–3 sprint project thanks to drop-in libraries from Auth0, Clerk, Stytch, MojoAuth, Hanko, and others.

### 2.3 Magic Links (passwordless, low-friction)

**How it works:** User enters their email. Server sends a one-time link valid for ~5–15 minutes. Clicking the link logs them in.

**Strengths:** No password to forget, simple UX, good fit for low-frequency apps.

**Weaknesses:** Depends on email security (if attacker has email, they have your account). Slower than passkeys. Doesn't work well for mobile apps.

**Who uses it:** Notion, Slack (as an option), Substack, many B2B SaaS.

### 2.4 OAuth / Social Login

**How it works:** Delegate identity verification to Google, GitHub, Apple, etc. Your system never sees the user's password.

**Strengths:** Zero credential storage on your side, MFA inherited from the provider, fast onboarding.

**Weaknesses:** Dependence on third party, account-linking complexity, privacy concerns (some users dislike "Log in with Google").

**Best practice in 2025–2026:** Use **OAuth 2.1** (a tightened revision of 2.0 that mandates PKCE and removes implicit flow). Always use **PKCE with S256** for the code exchange.

### 2.5 SSO (Enterprise)

**How it works:** Single sign-on via SAML or OIDC, typically backed by an identity provider like Okta, Azure AD, or Google Workspace.

**When to use:** B2B/enterprise products where customers expect to manage user accounts centrally.

---

## 3. Session Mechanisms — Keeping Users Logged In

Identity proof happens once. Session mechanism is what carries you through every subsequent request.

### 3.1 Session Cookies (server-side state)

The classic: server creates a session record in a database/cache, gives the browser a cookie containing only the session ID.

**Cookie flags that matter:**
- `HttpOnly` — JavaScript can't read it (blocks XSS theft)
- `Secure` — only sent over HTTPS
- `SameSite=Lax` (or `Strict`) — blocks CSRF
- `Path` — scope to the relevant subtree (e.g. `/admin`)

**Strengths:** Easy to revoke (delete the session record), no token bloat in requests, no leakage if XSS is contained.

**Weaknesses:** Requires server-side state, harder to scale across services.

### 3.2 JWT (stateless tokens)

A signed JSON payload carrying user info. The server verifies the signature on each request — no DB lookup needed.

**Structure:**
```
header.payload.signature
```
- **Header:** algorithm (`HS256`, `RS256`)
- **Payload:** user ID, expiry (`exp`), scopes/roles
- **Signature:** HMAC or RSA signature using a secret/private key

**Why it spread:** Stateless. Microservices can validate independently. No central session store.

**Pitfalls:**
- **Can't easily revoke** a JWT before it expires
- **Storage in localStorage** exposes it to XSS — prefer HttpOnly cookies
- **Algorithm confusion attacks** (`alg: none`, RS256→HS256) — use a library that pins the algorithm
- **Long-lived JWTs are dangerous** — keep access tokens 5–60 min, pair with a refresh token

**Modern pattern: short access token + refresh token**
```
Access token (JWT, 15 min)  → carries identity, verified per-request
Refresh token (opaque, 30 days) → stored in DB, used to mint new access tokens, revocable
```

### 3.3 Hybrid: OAuth + Session Cookie

A very common modern pattern:
1. User logs in via Google OAuth
2. Your server verifies the OAuth response
3. Your server issues its **own session cookie or JWT** for subsequent requests

The OAuth flow happens once. After that, your app is in control of session state.

---

## 4. Authorization — What Users Can Do

Authentication says "who you are." Authorization says "what you can do." They are different problems and should be designed separately.

### 4.1 RBAC (Role-Based Access Control)

Each user has one or more roles. Each role has permissions. Simple, well-understood.

### 4.2 ABAC (Attribute-Based)

Decisions made on attributes (user.dept == resource.dept, time-of-day, location). More flexible, more complex.

### 4.3 Scopes (OAuth)

OAuth access tokens carry scopes like `read:repo`, `write:issues`. The token *itself* declares what it can do.

For most apps, **start with RBAC** and add complexity only when you outgrow it.

---

## 5. Storing Credentials Safely

If you store any password (even just for the admin console), do this:

| Bad | Acceptable | Good |
|---|---|---|
| Plaintext in code | Plaintext in `.env` (single-admin only) | **bcrypt / argon2id hash in DB** |
| MD5 / SHA1 / SHA256 | bcrypt cost 10 | **argon2id** with sensible memory parameters |
| Same secret across envs | Per-env secret in env var | Per-env secret in a **secret manager** (Vault, AWS Secrets Manager, GCP Secret Manager) |

**Rule of thumb:** if you can read the credential, so can an attacker who gets the same access. Always one-way hash.

---

## 6. The 2026 Decision Tree

```
Building something new?
├── Is it consumer-facing?
│   ├── Yes → Passkey-first + OAuth fallback (Google/Apple)
│   └── No  → continue
├── Is it B2B / enterprise?
│   ├── Yes → SSO (SAML/OIDC) + Passkey for individual admins
│   └── No  → continue
├── Is it an internal admin tool, single user?
│   ├── Yes → Strong random token + IP allowlist, OR OAuth-gated by allowed GitHub/Google account
│   └── No  → continue
├── Building an API for third-party developers?
│   └── OAuth 2.1 + PKCE, scoped access tokens, optional API keys
└── Default → OAuth + own session cookie, plan to add Passkey
```

---

## 7. Specific Recommendations by App Type

### Public SaaS product (B2C)
- **Identity:** Passkey-first, with Google/Apple OAuth as fallback. Email magic link as a final fallback.
- **Session:** HttpOnly cookie holding a short-lived JWT or opaque session ID. Refresh via silent endpoint.
- **MFA:** Built into passkeys natively; offer TOTP for users on legacy devices.

### B2B SaaS
- **Identity:** SSO (OIDC) for enterprise plans, OAuth + Passkey for self-serve.
- **Session:** Same as B2C, but support session-per-tenant and admin-initiated revocation.

### Internal admin tool (single admin, e.g. yori-dict)
- **Identity:** Either (a) strong random `ADMIN_TOKEN` (32 bytes from `openssl rand -base64 32`) behind IP allowlist, or (b) Google/GitHub OAuth restricted to your single account.
- **Session:** HttpOnly signed cookie scoped to `/admin`.
- **Don't bother with:** JWT, refresh tokens, RBAC, MFA — overkill for one user.
- **Do bother with:** Rate limiting on login, audit logs of admin actions, `Secure` + `SameSite=Lax` cookies, HTTPS-only.

### Third-party API
- **Identity:** OAuth 2.1 + PKCE for user-delegated flows, signed API keys (mTLS for high-security) for machine-to-machine.
- **Session:** Short-lived access tokens (JWT or opaque), revocable refresh tokens.
- **Scopes:** Always scope tokens to the minimum required permissions.

---

## 8. Common Mistakes to Avoid

1. **Rolling your own crypto.** Use vetted libraries (`jose`, `bcrypt`, `argon2`). Never implement HMAC/JWT verification by hand.
2. **Storing JWTs in localStorage.** XSS will steal them. Use HttpOnly cookies.
3. **Long-lived access tokens.** A 30-day JWT is a 30-day liability if it leaks. Keep access tokens minutes-long.
4. **No revocation path.** If your only way to log out a compromised user is to wait for their token to expire, you have a problem.
5. **Treating MFA as optional for admins.** Admin accounts are the most valuable target — they should be the most protected.
6. **Custom OAuth implementations.** Use established libraries (`oauth4webapi`, `openid-client`, Auth.js / NextAuth, Clerk, Auth0).
7. **Forgetting the recovery flow.** What happens when a user loses their device? Designing this *after* launch is painful.
8. **Confusing authentication with authorization.** Login proves identity. Permissions are a separate layer. Keep them separate in code.

---

## 9. Quick Reference: When to Use What

| Need | Recommended approach |
|---|---|
| Consumer login, new build | Passkey + OAuth fallback |
| Consumer login, existing password app | Add passkey, deprecate passwords over 12 months |
| Enterprise login | SSO via OIDC (Okta, Azure AD) |
| Internal admin (1 person) | Strong random token + IP allowlist, OR OAuth gate |
| Internal admin (team) | OAuth gate + RBAC |
| Public API, third-party devs | OAuth 2.1 + PKCE, scoped tokens |
| Machine-to-machine | API keys or mTLS, optionally JWT with short expiry |
| Mobile app | OAuth 2.1 + PKCE + secure enclave storage |
| Service-to-service inside one company | mTLS, or short-lived JWTs signed by an internal KMS |

---

## 10. Further Reading

- **WebAuthn / Passkeys:** [State of Passkeys 2026](https://state-of-passkeys.io/), [Passkeys & WebAuthn in 2026 Migration Playbook](https://kawaldeepsingh.medium.com/passkeys-webauthn-in-2026-a-practical-migration-playbook-for-passwordless-authentication-5202f09c62a3)
- **OAuth 2.1:** [OAuth 2.1 specification](https://oauth.net/2.1/), [OAuth 2.1 vs 2.0](https://stytch.com/blog/oauth-2-1-vs-2-0/)
- **JWT security:** [JWT Security Best Practices 2026](https://www.appsecmaster.net/blog/jwt-security-guide-json-web-token-best-practices/)
- **Passwordless guide:** [The Developer's Practical Guide to Passwordless Authentication](https://securityboulevard.com/2026/03/the-developers-practical-guide-to-passwordless-authentication-in-2026/)
- **Modern auth patterns:** [5 Authentication Patterns Every Web Developer Should Know in 2026](https://dev.to/alanwest/5-authentication-patterns-every-web-developer-should-know-in-2026-50ol)

---

## Summary

If you remember only one thing from this document:

> **In 2026, the default for new apps should be passkeys (with OAuth fallback). For internal tools, a strong random token behind an IP allowlist or OAuth gate is enough. Never store plaintext passwords. Never use long-lived JWTs in localStorage. Always separate authentication from authorization.**

The right answer is rarely the trendiest one — it's the one that matches your actual threat model, user base, and team capacity to maintain it.

---

# 繁體中文版

# 現代身份驗證實務指南（2026）

身份驗證在過去三年的變化，比之前二十年都還要大。密碼正在被取代、Session 機制被重新設計，「使用者該怎麼登入？」這個問題不再只有一個答案。

這份文件整理了現代主流方案、用白話解釋每種做法的原理，並針對不同情境給出明確建議。

---

## 1. 大局觀

2026 年的身份驗證可以拆成**四個元件**：

| 元件 | 功能 | 例子 |
|---|---|---|
| **身份證明** | 證明使用者「是誰」 | 密碼、Passkey、Magic Link、OAuth 登入 |
| **Session 機制** | 維持登入狀態 | Cookie、JWT、OAuth access token |
| **授權層** | 決定「可以做什麼」 | RBAC、scopes、claims |
| **救援流程** | 帳號被鎖時如何恢復 | Email 重設、備用碼、信任聯絡人 |

實際系統會混搭使用這幾個元件。好的設計依照**威脅模型**選擇組合，而不是追逐流行。

---

## 2. 身份證明：如何證明你是誰

### 2.1 密碼（仍很常見，但漸漸被淘汰）

**運作方式：** 使用者輸入記得的字串，伺服器存雜湊（bcrypt、argon2、scrypt）。

**為什麼失寵：**
- 使用者會在多個網站重複使用密碼
- 釣魚攻擊是第一大威脅，而密碼特別容易被釣
- 即使密碼強度高，資料庫外洩後也會被破解

**如果還在用密碼，至少要做到：**
- 用 **argon2id** 或 **bcrypt**（成本參數 12 以上）雜湊
- 永遠不寫日誌、不存明文
- 強制最小長度，不要強制特殊符號（長度比複雜度重要）
- 搭配 **MFA**——光靠密碼已不足以保護任何重要資料

### 2.2 Passkey（2026 年的推薦預設）

**運作方式：** 使用者的裝置產生公私鑰對，綁定到你的網域。私鑰永遠不離開裝置。登入時，裝置用生物辨識（Face ID、指紋）或 PIN 簽名一個 challenge。

**為什麼重要：**
- **天然防釣魚**——金鑰綁定網域，假登入頁拿不到
- **沒有共享密鑰**——沒有密碼雜湊資料庫可洩漏
- **使用者完全不用記、不用重設、不用輪替**

**2026 年的普及狀況：** 主要平台（Apple、Google、Microsoft、GitHub、1Password）都支援跨裝置同步。瀏覽器（Chrome 108+、Safari 16+、Edge 108+）與作業系統（iOS 16+、Android 9+、macOS Ventura+、Windows 10+）已涵蓋絕大多數使用者。

**技術標準：** 建立在 **WebAuthn**（W3C）與 **FIDO2**（FIDO Alliance）之上。WebAuthn Level 3 已於 2025 年初發布 Working Draft。

**實作現狀：** 過去需要六個月的整合，現在只要 2–3 個 Sprint。Auth0、Clerk、Stytch、MojoAuth、Hanko 等都提供 drop-in 函式庫。

### 2.3 Magic Link（無密碼、低摩擦）

**運作方式：** 使用者輸入 Email，伺服器寄出一封有效期 5–15 分鐘的連結，點擊即登入。

**優點：** 沒有密碼可忘記、UX 簡單、適合低頻使用的應用。

**缺點：** 完全依賴 Email 安全性（攻擊者拿到 Email 就拿到帳號）。比 Passkey 慢。手機 App 整合不順。

**誰在用：** Notion、Slack（選項之一）、Substack、許多 B2B SaaS。

### 2.4 OAuth / 社群登入

**運作方式：** 把身份驗證委託給 Google、GitHub、Apple 等，你的系統不碰使用者密碼。

**優點：** 自己完全不存憑證、繼承第三方的 MFA、註冊體驗快。

**缺點：** 依賴第三方、帳號合併處理複雜、有些使用者排斥（隱私顧慮）。

**2025–2026 最佳實踐：** 使用 **OAuth 2.1**（強化版的 2.0，強制 PKCE、移除 implicit flow）。Code exchange 一定要用 **PKCE + S256**。

### 2.5 SSO（企業情境）

**運作方式：** 透過 SAML 或 OIDC 的單一登入，後端通常是 Okta、Azure AD、Google Workspace 等身份提供者。

**何時使用：** B2B/企業產品，客戶希望集中管理使用者帳號。

---

## 3. Session 機制：維持登入狀態

身份證明只發生一次，Session 機制負責後續每個請求。

### 3.1 Session Cookie（伺服器端有狀態）

經典方式：伺服器在資料庫/快取建立 session 紀錄，給瀏覽器一個只含 session ID 的 cookie。

**重要的 Cookie 屬性：**
- `HttpOnly`——JavaScript 讀不到（防 XSS 偷取）
- `Secure`——只在 HTTPS 傳送
- `SameSite=Lax`（或 `Strict`）——防 CSRF
- `Path`——限制範圍（例如 `/admin`）

**優點：** 容易撤銷（刪掉紀錄即可）、請求 header 不會膨脹、就算 XSS 也偷不到。

**缺點：** 需要伺服器端狀態、跨服務擴展較難。

### 3.2 JWT（無狀態 Token）

簽名過的 JSON 內容，攜帶使用者資訊。伺服器每次驗簽名即可，不需要查 DB。

**結構：**
```
header.payload.signature
```
- **Header：** 演算法（`HS256`、`RS256`）
- **Payload：** 使用者 ID、過期時間（`exp`）、角色/scopes
- **Signature：** 用 secret 或私鑰簽出來的 HMAC 或 RSA 簽章

**為什麼流行：** 無狀態。微服務各自驗證即可。不需要中央 session store。

**陷阱：**
- **過期前難以撤銷**
- **存在 localStorage** 會被 XSS 偷走——應該用 HttpOnly cookie
- **演算法混淆攻擊**（`alg: none`、RS256→HS256）——用會鎖定演算法的函式庫
- **長效 JWT 很危險**——access token 控制在 5–60 分鐘內，搭配 refresh token

**現代模式：短效 access token + refresh token**
```
Access token（JWT，15 分鐘）→ 攜帶身份，每個請求驗證
Refresh token（不透明字串，30 天）→ 存資料庫，可撤銷，用來換新 access token
```

### 3.3 混合模式：OAuth + Session Cookie

很常見的現代模式：
1. 使用者用 Google OAuth 登入
2. 你的伺服器驗證 OAuth 回應
3. 你的伺服器發出**自己的 session cookie 或 JWT**

OAuth 流程只發生一次，之後 session 完全在你掌握。

---

## 4. 授權：使用者可以做什麼

身份驗證問「你是誰」，授權問「你能做什麼」。這是兩個不同的問題，應該分開設計。

### 4.1 RBAC（角色式存取控制）

使用者有一或多個角色，角色有對應權限。簡單、容易理解。

### 4.2 ABAC（屬性式）

根據屬性決定（user.dept == resource.dept、時段、地理位置）。彈性高，但複雜。

### 4.3 Scopes（OAuth）

OAuth access token 攜帶 scopes，例如 `read:repo`、`write:issues`。Token 自己宣告能做什麼。

**多數應用：先用 RBAC**，等真的需要再升級。

---

## 5. 安全儲存憑證

如果你需要儲存任何密碼（即使只是管理後台），請這樣做：

| 不該做 | 可接受 | 推薦 |
|---|---|---|
| 寫死在程式碼 | 明文放 `.env`（單一管理員時） | **bcrypt / argon2id 雜湊存 DB** |
| MD5 / SHA1 / SHA256 | bcrypt 成本 10 | **argon2id** 搭配合理記憶體參數 |
| 多環境共用 secret | 每個環境獨立 env var | 用 **secret manager**（Vault、AWS Secrets Manager、GCP Secret Manager） |

**口訣：** 如果你看得到憑證，拿到同樣權限的攻擊者也看得到。永遠用單向雜湊。

---

## 6. 2026 決策樹

```
要開發新東西？
├── 面向一般使用者？
│   ├── 是 → Passkey 優先 + OAuth 備援（Google/Apple）
│   └── 否 → 繼續
├── B2B / 企業？
│   ├── 是 → SSO（SAML/OIDC）+ 個人管理員用 Passkey
│   └── 否 → 繼續
├── 單人內部管理工具？
│   ├── 是 → 強隨機 token + IP 白名單，或 OAuth 限制特定帳號
│   └── 否 → 繼續
├── 給第三方開發者的 API？
│   └── OAuth 2.1 + PKCE、scoped tokens、可選 API key
└── 預設 → OAuth + 自家 session cookie，未來加入 Passkey
```

---

## 7. 不同應用類型的具體建議

### 一般消費者產品（B2C）
- **身份：** Passkey 優先，Google/Apple OAuth 備援，Email Magic Link 為最後備援
- **Session：** HttpOnly cookie 裝短效 JWT 或不透明 session ID，靜默 endpoint 換新
- **MFA：** Passkey 天然內建；舊裝置使用者提供 TOTP

### B2B SaaS
- **身份：** 企業方案用 SSO（OIDC），自助方案用 OAuth + Passkey
- **Session：** 同 B2C，但要支援 per-tenant session 與管理員撤銷

### 內部管理工具（單一管理員，例如 yori-dict）
- **身份：** 強隨機 `ADMIN_TOKEN`（32 bytes，用 `openssl rand -base64 32` 產生）+ IP 白名單；或用 Google/GitHub OAuth 限制單一帳號
- **Session：** HttpOnly 簽名 cookie，限定 `/admin` 路徑
- **不需要：** JWT、refresh token、RBAC、MFA——對一個使用者來說太重
- **需要：** 登入端點 rate limit、管理操作 audit log、`Secure` + `SameSite=Lax`、HTTPS-only

### 第三方 API
- **身份：** 使用者委託流程用 OAuth 2.1 + PKCE，機器對機器用簽名 API key（高安全用 mTLS）
- **Session：** 短效 access token（JWT 或不透明），可撤銷 refresh token
- **Scopes：** Token 永遠縮限到最小必要權限

---

## 8. 常見錯誤

1. **自己刻密碼學。** 用已驗證的函式庫（`jose`、`bcrypt`、`argon2`），不要手刻 HMAC/JWT 驗證
2. **JWT 存 localStorage。** XSS 會把它偷走。用 HttpOnly cookie
3. **長效 access token。** 30 天的 JWT 一旦外洩就是 30 天的責任，控制在分鐘級
4. **沒有撤銷路徑。** 如果唯一登出方式是等 token 過期，就有問題
5. **管理員不啟用 MFA。** 管理員帳號價值最高，保護應該最強
6. **自訂 OAuth 實作。** 用既有函式庫（`oauth4webapi`、`openid-client`、Auth.js / NextAuth、Clerk、Auth0）
7. **忘記救援流程。** 使用者裝置丟了怎麼辦？上線後才設計很痛苦
8. **混淆驗證與授權。** 登入確認身份，權限是另一層。在程式碼裡也要分清楚

---

## 9. 快速對照表

| 需求 | 推薦做法 |
|---|---|
| 全新消費者登入 | Passkey + OAuth 備援 |
| 既有密碼系統的消費者 | 加入 Passkey，12 個月內逐步淘汰密碼 |
| 企業登入 | OIDC SSO（Okta、Azure AD） |
| 內部管理（1 人） | 強隨機 token + IP 白名單，或 OAuth gate |
| 內部管理（團隊） | OAuth gate + RBAC |
| 公開 API、第三方開發者 | OAuth 2.1 + PKCE、scoped tokens |
| 機器對機器 | API key 或 mTLS，可選短效 JWT |
| 行動 App | OAuth 2.1 + PKCE + 安全晶片儲存 |
| 公司內部服務間 | mTLS，或內部 KMS 簽名的短效 JWT |

---

## 10. 一句話總結

> **2026 年，新應用的預設應該是 Passkey（搭配 OAuth 備援）。內部工具用強隨機 token + IP 白名單，或 OAuth gate 就夠了。永遠不要存明文密碼。永遠不要在 localStorage 放長效 JWT。永遠把驗證與授權分開處理。**

對的答案很少是最潮的那個——它是最符合你**實際威脅模型、使用者規模、團隊維護能力**的那個。
