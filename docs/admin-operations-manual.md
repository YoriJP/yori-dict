# Admin Operations Manual / 管理画面運用マニュアル / Admin 操作手冊

This document is grouped by language: English first, then Japanese, then Traditional Chinese.
本文件依語言分組：英文在前，其次是日文，最後是繁體中文。
この文書は言語ごとにまとめています。英語、日本語、繁體中文の順です。

## English

This manual documents the current admin implementation in this workspace. It is intended for internal operators and engineers who need to inspect entries, review AI updates, manage releases, run jobs, and troubleshoot admin issues.

### Table of Contents

- 1. Admin Overview
- 2. Access and Authentication
- 3. Core Concepts
- 4. Daily Operations Runbooks
- 5. Page-by-Page Reference
- 6. Troubleshooting
- 7. Glossary and Route Map

### 1. Admin Overview

The Admin UI is an internal operations surface for release and `updates.sqlite` overlay workflows. It is not a public feature and it does not currently implement role-based permissions. Anyone who has `ADMIN_TOKEN` effectively has full admin access.

The current admin surface supports:

- inspecting one entry across release, source update, AI update, and effective lookup layers
- reviewing AI translations and AI example sets through queue / batch workflows
- creating a new word in snapshot JSON, then building a new release to publish it
- building a new release, activating an existing release, and promoting effective updates into a new release
- triggering source updates and Gemini imports
- reviewing batch status, batch contents, and failures
- checking update counts and orphaned word IDs

Operating principles:

- confirm the target environment and active release before making changes
- AI updates do not affect lookup until approved
- source updates become effective automatically
- `promote` only bakes currently effective data into a new release
- `promote` skips orphaned updates instead of failing the whole release build
- `New Word` writes to snapshot files first, then requires a release build before lookup can see it
- `New Word -> Build release` builds from the full current snapshot and does not silently bake overlay updates into the release

### 2. Access and Authentication

Prerequisites:

- the service is running, usually via `bun run dev`
- `ADMIN_TOKEN` is set in the environment
- the environment can access the active release and `updates.sqlite`
- the active release may come from `releases/current.json` or from an env override such as `RELEASE_DB_PATH`

Current admin authentication methods:

- Basic Auth: any username plus `ADMIN_TOKEN` as the password
- Bearer token: `Authorization: Bearer <ADMIN_TOKEN>`
- `x-admin-token` header: `x-admin-token: <ADMIN_TOKEN>`

How to enter:

1. Set `ADMIN_TOKEN`
2. Start the service
3. Open `/admin`
4. If the browser shows a Basic Auth prompt, enter any username and use `ADMIN_TOKEN` as the password

Important constraints:

- if `ADMIN_TOKEN` is missing, admin is disabled
- this is not a multi-role back office and there is no read-only mode
- anyone with the token can build, activate, promote, write snapshots, and trigger jobs

Security guidance:

- never expose `ADMIN_TOKEN` in screenshots, recordings, or shared docs
- avoid long-term reuse of the same token across many people
- verify the target environment before any `activate`, `promote`, or `new word` action

### 3. Core Concepts

#### Shared Term Table

| Term | 繁體中文 | English | 日本語 | Meaning |
| --- | --- | --- | --- | --- |
| immutable release | 不可變 release | immutable release | immutable release / 不変 release | A built release DB and manifest that are treated as a frozen snapshot. |
| active release | 目前生效版本 | active release | active release / 現在有効な release | The release currently used as the runtime base. |
| updates overlay | 更新覆蓋層 | updates overlay | updates overlay / 更新 overlay | Incremental data stored in `updates.sqlite` on top of the active release. |
| source update | 來源更新 | source update | source update / ソース更新 | Deterministic imported update. Effective automatically. |
| AI update | AI 更新 | AI update | AI update / AI 更新 | Generated update from Gemini. Requires approval before becoming effective. |
| pending | 待審核 | pending | pending / 審査待ち | AI update exists but is not effective yet. |
| approved | 已批准 | approved | approved / 承認済み | AI update is approved and can become effective. |
| rejected | 已拒絕 | rejected | rejected / 却下済み | AI update was reviewed and rejected. |
| not_required | 不需審核 | not_required | not_required / 審査不要 | Source update state. Review is not required. |
| active | 作用中 | active | active / 有効 | Current update record is still the live candidate. |
| superseded | 已被取代 | superseded | superseded / 置き換え済み | A newer update replaced this one. |
| promoted | 已烘焙進 release | promoted | promoted / release へ反映済み | Update has already been baked into a promoted release. |
| batch | 批次 | batch | batch / バッチ | One source-update or AI-import execution record. |
| effective lookup | 實際查詢結果 | effective lookup | effective lookup / 実効 lookup | What the API returns after combining active release and effective updates. |
| build | 建立 release | build | build / release 作成 | Create a new release from snapshot or effective data. |
| activate | 切換生效版本 | activate | activate / 有効化 | Point runtime to a specific release. |
| promote | 將 effective updates 烘焙進 release | promote | promote / effective updates を release 化 | Create a new release from current effective data and mark included updates as promoted. |

Data flow rules:

- the runtime base comes from the active release
- the active release is resolved by runtime config, either from the managed pointer or an env override
- `updates.sqlite` is layered on top of the active release at lookup time
- source updates become effective automatically
- AI updates only become effective after `approved`
- source updates outrank AI updates
- `promote` only carries currently effective data into a new release

Release action differences:

- `Build release`: create a new release from current snapshot data, optionally activate it immediately
- `New word build release`: verify that the requested new word exists in snapshot data, then still build from the full current snapshot
- `Activate release`: switch the active pointer without rebuilding data
- `Promote release`: create a new release from the current effective lookup state and mark included updates as `promoted`
- orphaned updates may still appear in admin and verification views, but promote does not write them into the new release

Batch status meanings:

- `running`: the job is still in progress
- `succeeded`: the job completed successfully
- `failed`: the job ended with an error, inspect batch detail for the error

### 4. Daily Operations Runbooks

#### 4.1 Sign in and confirm admin availability

- Purpose: Verify that admin is enabled, authentication works, and the system is operable.
- Preconditions: `ADMIN_TOKEN` is set and the service is running.
- Steps:
  1. Open `/admin`
  2. Complete Basic Auth or another token-based auth flow
  3. Confirm that Dashboard renders an active release and summary metrics
- Expected result: Dashboard is visible instead of a 401 or admin-disabled response.
- Risks / do not do: Do not run release or job actions before confirming the correct environment.
- Recovery: Check `ADMIN_TOKEN`, service startup, and the target URL.
- Engineering notes: When `ADMIN_TOKEN` is missing, admin middleware returns a disabled message.

#### 4.2 Inspect one word across all layers

- Purpose: Compare one entry across release, source, AI, and effective layers.
- Preconditions: You are signed in and know the target word and language.
- Steps:
  1. Open `Entry Inspector`
  2. Enter the word and language
  3. Compare `Effective Lookup`, `Release Layer`, `Source Update Layer`, and `AI Update Layer`
  4. Expand raw JSON when more detail is needed
- Expected result: You can tell whether users are seeing base release data or an override from updates.
- Risks / do not do: Do not assume lookup changed just because an AI layer exists. Check review state and effective data.
- Recovery: If not found, try the reading, then confirm whether the entry exists in the active release or was created recently without a release build.
- Engineering notes: Full source/AI payload details appear in JSON blocks. Effective data is the real API-visible result.

#### 4.3 Review AI translations and example sets

- Purpose: Review AI candidates through the queue and batch workflow, and decide which ones may enter effective lookup.
- Preconditions: Pending AI updates exist, usually after a Gemini import, and you know which batch or language you want to review first.
- Steps:
  1. Open `/admin/review` and inspect `Queue Summary`
  2. Enter the newest or highest-risk batch through `/admin/review/batch/:id`
  3. Filter review units by language, risk, shape, or source-conflict status
  4. Use per-unit `Approve` / `Reject`, or select multiple units and use `Approve selected` / `Reject selected`
  5. Only use the source-conflict override when you intentionally want to approve an AI unit that conflicts with the current source-effective state
- Expected result: `approved` AI updates become effective. `rejected` ones do not.
- Risks / do not do: Review is not the same as release publishing. Approval changes effective lookup, but does not create a new release.
- Recovery: If lookup still does not change, inspect the entry again and check whether a source update outranks the AI update, whether the wrong language was queried, or whether the bulk action was blocked.
- Engineering notes: `/admin/review` is now a queue dashboard rather than a flat per-item list. Bulk review endpoints enforce single-batch, single-language scope and guard against source conflicts by default.

#### 4.4 Create a new word

- Purpose: Add a canonical word into snapshot data for the next release.
- Preconditions: The word should not already exist. You need the word, reading, and at least one translation.
- Steps:
  1. Open `New Word`
  2. Fill `Word`, `Reading`, and optional `Part of speech`, `JLPT`, and `Common`
  3. Add at least one language block with definitions and optional examples
  4. Click `Save new word`
  5. Build a release afterwards; other snapshot edits can be published in the same build
- Expected result: The word is written to snapshot files, but lookup still will not see it until a release is built and activated. The later new-word build-release uses the full current snapshot, not a one-word-only overlay.
- Risks / do not do: Do not treat this as publishing. Do not enter non-Japanese reading text. Do not duplicate language rows.
- Recovery: A 409 means duplicate conflict. A 400 means validation failure. If creation succeeded but lookup still cannot find it, build a release first.
- Engineering notes: This writes to `data/core.json` and matching `data/lang/*.json`. Definition and example sources are tagged as `manual`. The new-word build-release endpoint uses `createdWordId` only as an existence check and does not bake current overlay updates into the release.

#### 4.5 Build a new release

- Purpose: Create a new immutable release from current snapshot data.
- Preconditions: Snapshot data is ready. If using `New Word`, saving has already completed.
- Steps:
  1. Open `Releases`
  2. Enter a version override in `Build New Release`, or leave it empty for auto-generation
  3. Choose `Build and activate` or `Build only`
  4. Click `Build release`
- Expected result: A new release appears in Release Inventory. If activation was selected, the active release also changes.
- Risks / do not do: `Build only` does not change the active pointer. Do not assume users are on the new data just because build succeeded.
- Recovery: If the new word still is not visible, confirm whether this build was activated. If not, activate that release separately.
- Engineering notes: Build uses snapshot data, not the current effective overlay. If you need to freeze current effective source/approved AI overlay data into a release, use promote instead.

#### 4.6 Activate an existing release

- Purpose: Switch runtime to an existing release.
- Preconditions: The target release already exists in Release Inventory.
- Steps:
  1. Open `Releases`
  2. Find the target version in Release Inventory
  3. Trigger the activate action for that version
- Expected result: The selected version becomes the active release.
- Risks / do not do: Activate does not merge new updates and does not rebuild data.
- Recovery: If the wrong release was activated, activate the correct one.
- Engineering notes: This only changes the pointer. It does not rewrite snapshot files or update records.

#### 4.7 Promote effective updates into a release

- Purpose: Bake current effective source updates and approved AI updates into a new release.
- Preconditions: Any AI updates that must be included are already approved.
- Steps:
  1. Open `Releases`
  2. Use `Promote Updates` with an optional version override
  3. Choose `Promote and activate` or `Promote only`
  4. Click `Promote release`
- Expected result: A new release is built from the current effective state, included updates are marked `promoted`, and orphaned updates are skipped instead of blocking the promote.
- Risks / do not do: Unapproved AI updates will not be included. Do not confuse promote with plain activate.
- Recovery: If expected data is missing from the new release, confirm that it was effective at promote time and verify review state and language.
- Engineering notes: Promote creates a merged snapshot from active release plus effective updates, then writes a new release. Updates that point to words missing from the release snapshot are treated as orphaned and skipped.

#### 4.8 Run a source update job

- Purpose: Generate update records from deterministic upstream sources.
- Preconditions: Required source data and environment prerequisites are ready.
- Steps:
  1. Open `Jobs`
  2. Enter languages in `Source Update`, or leave empty for the default scope
  3. Choose `Write updates` or `Dry run`
  4. Click `Run source update`
  5. Inspect Batch History for the result
- Expected result: A successful run creates a batch and update records. Source updates become effective automatically.
- Risks / do not do: Use dry run first if source quality is uncertain. Source updates can override AI-visible results.
- Recovery: Open batch detail for the error. If the result is unexpected, compare the source layer in Entry Inspector.
- Engineering notes: Source updates do not require review and outrank AI updates in effective resolution.

#### 4.9 Run a Gemini import job

- Purpose: Generate AI translation and example candidates for later review.
- Preconditions: Gemini API access and model configuration are available.
- Steps:
  1. Open `Jobs`
  2. Configure languages, seed language, model, limit, frequency, cost, and related options in `Gemini Import`
  3. Use `Dry run` first to validate scope
  4. Switch to `Write pending reviews` when ready to write
  5. Review results in `/admin/review` and `Batch History`
- Expected result: A write run creates pending AI updates that do not affect lookup until approved.
- Risks / do not do: Do not skip dry run for a wide scope. Do not treat pending review creation as publication.
- Recovery: If the batch fails, inspect batch detail. If it succeeds but no items appear, confirm that candidates were actually generated and that language filters are correct.
- Engineering notes: Gemini import writes into the overlay DB, and AI updates default to review state `pending`.

#### 4.10 Inspect batch history and failures

- Purpose: Determine whether a job succeeded, why it failed, and what updates it produced.
- Preconditions: At least one source update or Gemini import has been run.
- Steps:
  1. Open `Jobs`
  2. Find the target batch in `Batch History`
  3. Open the detail view from the batch id
  4. Inspect `kind`, `status`, `actor`, `created/completed`, and `error`
  5. Review translation and example update output below
- Expected result: You can identify job outcome, failure cause, and actual output records.
- Risks / do not do: Do not stop at succeeded/failed alone. Validate whether the output matches expectation.
- Recovery: If `failed`, fix the error and rerun. If `succeeded` but output is wrong, validate data again in Entry Inspector or Updates.
- Engineering notes: A batch records one job execution. Effective behavior still depends on review and layer resolution.

### 5. Page-by-Page Reference

| Page | Who uses it | Main controls | When to use it | Common misuse | Related API / behavior |
| --- | --- | --- | --- | --- | --- |
| Dashboard | Operators, engineers | metric strip, Recent Batches, Quick Actions | when checking overall system state | stopping at counts without drilling into details | `/admin/api/summary` |
| Entry Inspector | Operators, engineers | Word, Language, raw JSON | when validating one entry end to end | treating AI layer as already effective | `/admin/api/entries` |
| Review Queue | Primarily operators, with engineering support | Queue Summary, batch links, filters, single/bulk approve/reject | when reviewing AI-generated candidates | assuming approval equals release publication, or ignoring source-conflict guardrails | `/admin/api/review/queue`, `/admin/api/review/batches/:id/summary`, `/admin/api/review/units/*`, legacy `/admin/api/review/ai` |
| New Word | Content maintainers, engineers | Core Fields, Translations, Save new word | when adding a canonical new entry | expecting lookup visibility before release build | `/admin/api/new-word`, `/admin/api/new-word/build-release` |
| Releases | Operators, engineers | Build release, Promote release, activate action | when managing release lifecycle | confusing build, activate, and promote | `/admin/api/releases*` |
| Jobs | Operators, engineers | Source Update, Gemini Import, Batch History | when running batch operations and checking output | running wide writes without a dry run | `/admin/api/jobs/*`, `/admin/api/batches/:id` |
| Updates | Mainly engineers, optionally operators | language/source/review filters, update cards, verification summary | when reviewing global update state | ignoring review status and source type differences | `/admin/api/updates` |

### 6. Troubleshooting

| Problem | Common cause | Recommended action |
| --- | --- | --- |
| `/admin` does not open or says disabled | `ADMIN_TOKEN` is missing, or service is not running | Verify env vars and service state, then retry |
| Authentication keeps failing | password is not `ADMIN_TOKEN`, or header format is wrong | Use any username plus the correct token for Basic Auth, or switch to Bearer / `x-admin-token` |
| An AI update exists but lookup does not show it | it is still `pending`, a source update outranks it, or a bulk approval was blocked by conflict guardrails | Check queue/batch state in `/admin/review`, then compare effective and source layers in `Entry Inspector` |
| A release was built but content did not switch | `Build only` was chosen instead of activation | Activate that version in `Releases`, or use `Build and activate` next time |
| Expected data is missing after promote | the AI update was not approved, or it was not effective at promote time | Confirm review state first, then validate effective layer in `Entry Inspector` |
| A batch failed | source prerequisites, model config, cost controls, or execution errors | Open batch detail in `Jobs`, read `error`, fix the issue, and rerun |
| Orphaned word IDs appear | updates point to words that are not present in the active release | Assess impact in `Updates` and `Entry Inspector`. Promote skips those rows, but you should still decide whether rebuild or cleanup is needed |

### 7. Glossary and Route Map

| Page / capability | Route | Main API | Notes |
| --- | --- | --- | --- |
| Dashboard | `/admin` | `/admin/api/summary` | system overview and recent batches |
| Entry Inspector | `/admin/entry` | `/admin/api/entries` | inspect one entry across layers |
| Review Queue | `/admin/review` | `/admin/api/review/queue`, legacy `/admin/api/review/ai` | queue summary and recent batch entry points |
| Batch Review | `/admin/review/batch/:id` | `/admin/api/review/batches/:id/summary`, `/admin/api/review/units/approve`, `/admin/api/review/units/reject`, single approve/reject endpoints | review AI units one by one or in bulk |
| New Word | `/admin/new-word` | `/admin/api/new-word`, `/admin/api/new-word/build-release` | writes snapshot first, then needs a release build |
| Releases | `/admin/releases` | `/admin/api/releases`, `/admin/api/releases/build`, `/admin/api/releases/:version/activate`, `/admin/api/releases/promote` | build / activate / promote lifecycle |
| Jobs | `/admin/jobs` | `/admin/api/jobs/source-update`, `/admin/api/jobs/gemini-import`, `/admin/api/batches/:id` | run jobs and inspect batches |
| Updates | `/admin/updates` | `/admin/api/updates` | global update visibility |

### Implementation Notes

- This document intentionally reflects the current workspace implementation, including the current `New Word` flow.
- It does not describe any role model, approval layer, or automation that is not present in the code.
- Screenshots are intentionally omitted in v1 to keep the manual maintainable while the admin UI is still evolving.

## 日本語

このマニュアルは、この workspace にある現在の admin 実装を基準に作成しています。対象読者は、内部オペレーターとエンジニアです。単語確認、AI 審査、リリース管理、ジョブ実行、障害対応を扱います。

### 目次

- 1. 管理画面概要
- 2. アクセスと認証
- 3. 基本概念
- 4. 日常運用 Runbook
- 5. ページ別リファレンス
- 6. トラブルシューティング
- 7. 用語集とルート対応表

### 1. 管理画面概要

Admin UI は、リリース管理と `updates.sqlite` overlay を扱うための内部運用画面です。一般ユーザー向け機能ではなく、現状ではロール別権限制御もありません。`ADMIN_TOKEN` を持つ利用者は、実質的にフル権限を持ちます。

現在の admin 画面でできることは次のとおりです。

- 1 件の単語を release、source update、AI update、effective lookup の各レイヤーで確認する
- queue / batch workflow で AI translation と AI example set を承認または却下する
- snapshot JSON に新規語彙を追加し、その後 release を build して公開する
- 新規 release を build する、既存 release を activate する、effective updates を新しい release に promote する
- source update と Gemini import を実行する
- batch の状態、内容、失敗理由を確認する
- 更新件数や orphaned word IDs を確認する

運用上の基本ルール:

- 操作前に対象環境と active release を確認する
- AI update は承認前には lookup に反映されない
- source update は自動的に effective data になる
- `promote` は、その時点で effective な内容だけを新しい release に取り込む
- `promote` は orphaned updates を見つけても release build 全体を失敗させず、その行だけをスキップする
- `New Word` はまず snapshot に書き込まれ、その後 release build をしないと lookup に反映されない
- `New Word -> Build release` は現在の snapshot 全体から release を作り、overlay updates を勝手に release 化しない

### 2. アクセスと認証

前提条件:

- サービスが起動していること。通常は `bun run dev`
- 環境変数 `ADMIN_TOKEN` が設定されていること
- 対象環境から active release と `updates.sqlite` にアクセスできること
- active release は `releases/current.json` の場合もあれば、`RELEASE_DB_PATH` などの env override の場合もある

現在サポートされている認証方法:

- Basic Auth: ユーザー名は任意、パスワードに `ADMIN_TOKEN` を使用
- Bearer token: `Authorization: Bearer <ADMIN_TOKEN>`
- `x-admin-token` header: `x-admin-token: <ADMIN_TOKEN>`

利用手順:

1. `ADMIN_TOKEN` を設定する
2. サービスを起動する
3. `/admin` を開く
4. Basic Auth ダイアログが表示された場合は、ユーザー名は任意、パスワードに `ADMIN_TOKEN` を入力する

重要な制約:

- `ADMIN_TOKEN` が未設定の場合、admin は無効化される
- この画面にロール分離や read-only 権限はない
- token を持つ利用者は build、activate、promote、snapshot 更新、job 実行を行える

セキュリティ上の注意:

- `ADMIN_TOKEN` をスクリーンショット、録画、共有資料に残さない
- 同じ token を多数の利用者で長期共有しない
- `activate`、`promote`、`new word` 実行前に対象環境を確認する

### 3. 基本概念

#### 用語対照表

| Term | 繁體中文 | English | 日本語 | Meaning |
| --- | --- | --- | --- | --- |
| immutable release | 不可變 release | immutable release | immutable release / 不変 release | A built release DB and manifest that are treated as a frozen snapshot. |
| active release | 目前生效版本 | active release | active release / 現在有効な release | The release currently used as the runtime base. |
| updates overlay | 更新覆蓋層 | updates overlay | updates overlay / 更新 overlay | Incremental data stored in `updates.sqlite` on top of the active release. |
| source update | 來源更新 | source update | source update / ソース更新 | Deterministic imported update. Effective automatically. |
| AI update | AI 更新 | AI update | AI update / AI 更新 | Generated update from Gemini. Requires approval before becoming effective. |
| pending | 待審核 | pending | pending / 審査待ち | AI update exists but is not effective yet. |
| approved | 已批准 | approved | approved / 承認済み | AI update is approved and can become effective. |
| rejected | 已拒絕 | rejected | rejected / 却下済み | AI update was reviewed and rejected. |
| not_required | 不需審核 | not_required | not_required / 審査不要 | Source update state. Review is not required. |
| active | 作用中 | active | active / 有効 | Current update record is still the live candidate. |
| superseded | 已被取代 | superseded | superseded / 置き換え済み | A newer update replaced this one. |
| promoted | 已烘焙進 release | promoted | promoted / release へ反映済み | Update has already been baked into a promoted release. |
| batch | 批次 | batch | batch / バッチ | One source-update or AI-import execution record. |
| effective lookup | 實際查詢結果 | effective lookup | effective lookup / 実効 lookup | What the API returns after combining active release and effective updates. |
| build | 建立 release | build | build / release 作成 | Create a new release from snapshot or effective data. |
| activate | 切換生效版本 | activate | activate / 有効化 | Point runtime to a specific release. |
| promote | 將 effective updates 烘焙進 release | promote | promote / effective updates を release 化 | Create a new release from current effective data and mark included updates as promoted. |

データフローのルール:

- 実行時の基盤データは active release から来る
- active release は runtime 設定で解決され、managed pointer の場合も env override の場合もある
- `updates.sqlite` は lookup 時に active release の上に重ねられる
- source update は自動で effective になる
- AI update は `approved` になって初めて effective になる
- source update は AI update より優先される
- `promote` は、その時点で effective な内容だけを新しい release に取り込む

release 操作の違い:

- `Build release`: 現在の snapshot から新しい release を作成し、必要なら即座に activate できる
- `New word build release`: 指定した新規語彙が snapshot に存在することを確認したうえで、現在の snapshot 全体から release を作成する
- `Activate release`: データを再作成せず、active pointer だけを切り替える
- `Promote release`: 現在の effective lookup 状態から新しい release を作成し、取り込まれた update を `promoted` にする
- orphaned updates は admin / verify には表示され得るが、promote 時には新 release へ書き込まれない

batch 状態の意味:

- `running`: job 実行中
- `succeeded`: job 完了
- `failed`: job 失敗。batch detail でエラーを確認する

### 4. 日常運用 Runbook

#### 4.1 Sign in and confirm admin availability

- Purpose: admin が有効で、認証が通り、画面操作が可能か確認する。
- Preconditions: `ADMIN_TOKEN` が設定され、サービスが起動している。
- Steps:
  1. `/admin` を開く
  2. Basic Auth または token 認証を通す
  3. Dashboard に active release と集計が表示されることを確認する
- Expected result: 401 や無効化メッセージではなく Dashboard が表示される。
- Risks / do not do: 対象環境を確認する前に release や job を操作しない。
- Recovery: `ADMIN_TOKEN`、サービス起動、URL を確認する。
- Engineering notes: `ADMIN_TOKEN` 未設定時は admin middleware が無効化メッセージを返す。

#### 4.2 Inspect one word across all layers

- Purpose: 1 件の単語について、release、source、AI、effective の各レイヤー差分を確認する。
- Preconditions: admin にログイン済みで、対象の word と language が分かっている。
- Steps:
  1. `Entry Inspector` を開く
  2. word と language を入力する
  3. `Effective Lookup`、`Release Layer`、`Source Update Layer`、`AI Update Layer` を比較する
  4. 詳細が必要な場合は raw JSON を展開する
- Expected result: 現在のユーザー向け結果が release 由来か、update による上書きかを判断できる。
- Risks / do not do: AI layer があるだけで lookup が変わったと判断しない。review 状態と effective layer を確認する。
- Recovery: 見つからない場合は reading でも検索し、それでも無ければ active release に存在するか、release build 前の新規語彙かを確認する。
- Engineering notes: source/AI の詳細 payload は JSON block で確認する。実際の API 表示結果は effective data。

#### 4.3 Review AI translations and example sets

- Purpose: queue / batch workflow で AI candidates を審査し、どの内容を effective lookup に反映させるか判断する。
- Preconditions: pending AI updates が存在すること。通常は Gemini import 後に発生し、先に見る batch または言語の見当がついていること。
- Steps:
  1. `/admin/review` を開き、`Queue Summary` を確認する
  2. 最新 batch または高リスク batch から `/admin/review/batch/:id` に入る
  3. language、risk、shape、source conflict で review unit を絞り込む
  4. 各 unit の `Approve` / `Reject` を使うか、複数選択して `Approve selected` / `Reject selected` を使う
  5. source conflict override は、現在 source-effective な結果と競合する AI unit を意図的に承認したいときだけ使う
- Expected result: `approved` になった AI update は effective になる。`rejected` は反映されない。
- Risks / do not do: review は release 公開ではない。承認は effective lookup を変えるだけで、新しい release は自動作成されない。
- Recovery: 承認後も結果が変わらない場合は、Entry Inspector で source update に上書きされていないか、言語指定が正しいか、または bulk action がブロックされていないか確認する。
- Engineering notes: `/admin/review` は現在 queue dashboard であり、単純な平面カード一覧ではない。bulk review endpoint は同一 batch・同一言語に制限され、source conflict を既定で保護する。

#### 4.4 Create a new word

- Purpose: 次の release 用に、snapshot データへ正式な単語を追加する。
- Preconditions: 同じ語彙が未登録であること。word、reading、少なくとも 1 つの translation が必要。
- Steps:
  1. `New Word` を開く
  2. `Word`、`Reading`、必要に応じて `Part of speech`、`JLPT`、`Common` を入力する
  3. 少なくとも 1 つの言語ブロックを追加し、definitions と必要なら examples を入力する
  4. `Save new word` を押す
  5. その後で release を build する。同じタイミングで他の snapshot 変更も一緒に公開できる
- Expected result: 単語は snapshot ファイルに書き込まれるが、release build と activate が終わるまで lookup には出ない。後続の new-word build-release は 1 語だけでなく、現在の snapshot 全体を対象にする。
- Risks / do not do: これを公開完了と誤解しない。reading に日本語以外を入れない。言語行を重複させない。
- Recovery: 409 は重複、400 はバリデーションエラー。作成成功後も lookup に出ない場合は release を build する。
- Engineering notes: `data/core.json` と対応する `data/lang/*.json` に書き込み、source は `manual` として記録される。new-word build-release の `createdWordId` は存在確認用であり、現在の overlay updates をそのまま release に焼き込むものではない。

#### 4.5 Build a new release

- Purpose: 現在の snapshot データから新しい immutable release を作成する。
- Preconditions: snapshot が準備済みであること。`New Word` を使った場合は保存が完了していること。
- Steps:
  1. `Releases` を開く
  2. `Build New Release` で version override を入力するか、空欄で自動生成にする
  3. `Build and activate` または `Build only` を選ぶ
  4. `Build release` を押す
- Expected result: Release Inventory に新しい release が追加される。activate を選んだ場合は active release も切り替わる。
- Risks / do not do: `Build only` は active pointer を切り替えない。build 成功だけで利用者が新データを見ているとは限らない。
- Recovery: 新しい単語が見えない場合は、その build が activate されたか確認する。未反映なら別途 activate する。
- Engineering notes: build は snapshot データから行われ、effective overlay から逆算されるわけではない。現在 effective な source/approved AI overlay を release に固定したい場合は promote を使う。

#### 4.6 Activate an existing release

- Purpose: 実行時の基盤を既存の release に切り替える。
- Preconditions: 対象 release が Release Inventory に存在する。
- Steps:
  1. `Releases` を開く
  2. Release Inventory で対象 version を探す
  3. その version に対して activate を実行する
- Expected result: 選択した version が active release になる。
- Risks / do not do: activate は新しい updates を取り込まないし、data build もしない。
- Recovery: 間違った version を有効化した場合は、正しい version を再度 activate する。
- Engineering notes: これは pointer の切り替えのみで、snapshot や update record は変更しない。

#### 4.7 Promote effective updates into a release

- Purpose: 現在 effective な source update と承認済み AI update を新しい release に取り込む。
- Preconditions: 取り込みたい AI update が承認済みであること。
- Steps:
  1. `Releases` を開く
  2. `Promote Updates` で必要なら version override を指定する
  3. `Promote and activate` または `Promote only` を選ぶ
  4. `Promote release` を押す
- Expected result: 現在の effective 状態から新しい release が作られ、取り込まれた updates は `promoted` になる。orphaned updates は promote を止めずにスキップされる。
- Risks / do not do: 未承認の AI update は含まれない。promote を単なる activate と混同しない。
- Recovery: 期待したデータが新 release に入らない場合は、promote 時点で effective だったか、review 状態と言語指定を確認する。
- Engineering notes: promote は active release と effective updates をマージした snapshot から新しい release を作成する。release snapshot に存在しない word を指す update は orphaned とみなし、promote 時には取り込まない。

#### 4.8 Run a source update job

- Purpose: deterministic な上流データから update record を生成する。
- Preconditions: 必要な source data と実行条件が揃っている。
- Steps:
  1. `Jobs` を開く
  2. `Source Update` に言語を入力する。空欄なら既定範囲
  3. `Write updates` または `Dry run` を選ぶ
  4. `Run source update` を押す
  5. Batch History で結果を確認する
- Expected result: 成功すると batch と update records が作成され、source update は自動的に effective になる。
- Risks / do not do: source 品質が不確かな場合は先に dry run を使う。source update は AI の見え方を上書きすることがある。
- Recovery: batch detail でエラーを見る。結果が想定と違う場合は Entry Inspector の source layer を確認する。
- Engineering notes: source update は review 不要で、effective 解決では AI より優先される。

#### 4.9 Run a Gemini import job

- Purpose: 後続 review 用の AI translation と example candidate を生成する。
- Preconditions: Gemini API へのアクセスとモデル設定が利用可能であること。
- Steps:
  1. `Jobs` を開く
  2. `Gemini Import` で languages、seed language、model、limit、frequency、cost などを設定する
  3. まず `Dry run` で対象範囲を確認する
  4. 実際に書き込む場合は `Write pending reviews` に切り替える
  5. `/admin/review` と `Batch History` で結果を確認する
- Expected result: 書き込み実行時には pending AI updates が生成され、承認されるまでは lookup に反映されない。
- Risks / do not do: 広い範囲で dry run を飛ばさない。pending reviews の作成を公開完了と誤解しない。
- Recovery: batch が失敗したら batch detail を確認する。成功しても項目が出ない場合は、候補が生成されたか、言語フィルタが正しいか確認する。
- Engineering notes: Gemini import は overlay DB に書き込み、AI updates の初期 review 状態は `pending`。

#### 4.10 Inspect batch history and failures

- Purpose: job が成功したか、なぜ失敗したか、どの update を出力したかを確認する。
- Preconditions: 少なくとも 1 回 source update または Gemini import を実行済みであること。
- Steps:
  1. `Jobs` を開く
  2. `Batch History` で対象 batch を探す
  3. batch id から detail を開く
  4. `kind`、`status`、`actor`、`created/completed`、`error` を確認する
  5. 下部の translation/example update 出力を確認する
- Expected result: job の成否、失敗理由、出力内容を判断できる。
- Risks / do not do: succeeded/failed だけで判断しない。出力内容が期待どおりかも見る。
- Recovery: `failed` の場合は error を修正して再実行する。`succeeded` でも結果がおかしい場合は Entry Inspector または Updates で再確認する。
- Engineering notes: batch は 1 回の job 実行記録であり、最終的な有効性は review 状態と layer 解決にも依存する。

### 5. ページ別リファレンス

| Page | 主な利用者 | 主な操作 | 使う場面 | よくある誤用 | 関連 API / 動作 |
| --- | --- | --- | --- | --- | --- |
| Dashboard | オペレーター、エンジニア | metric 表示、Recent Batches、Quick Actions | 全体状況を最初に確認するとき | 件数だけ見て詳細確認をしない | `/admin/api/summary` |
| Entry Inspector | オペレーター、エンジニア | Word、Language、raw JSON | 1 件の単語を端から端まで確認するとき | AI layer がそのまま有効だと思い込む | `/admin/api/entries` |
| Review Queue | 主にオペレーター、必要に応じてエンジニア | Queue Summary、batch link、filter、単体/一括 approve/reject | AI 候補を審査するとき | 承認を release 公開と混同したり、source conflict 保護を無視したりする | `/admin/api/review/queue`、`/admin/api/review/batches/:id/summary`、`/admin/api/review/units/*`、legacy `/admin/api/review/ai` |
| New Word | コンテンツ担当、エンジニア | Core Fields、Translations、Save new word | 正式な新規語彙を追加するとき | release build 前に lookup へ出ると思い込む | `/admin/api/new-word`、`/admin/api/new-word/build-release` |
| Releases | オペレーター、エンジニア | Build release、Promote release、activate action | release ライフサイクルを管理するとき | build、activate、promote を混同する | `/admin/api/releases*` |
| Jobs | オペレーター、エンジニア | Source Update、Gemini Import、Batch History | batch 実行と結果確認をするとき | dry run なしで広範囲書き込みを行う | `/admin/api/jobs/*`、`/admin/api/batches/:id` |
| Updates | 主にエンジニア、必要に応じてオペレーター | language/source/review filters、update cards、verification summary | 全体の更新状態を確認するとき | review 状態や source type を無視する | `/admin/api/updates` |

### 6. トラブルシューティング

| 問題 | よくある原因 | 推奨対応 |
| --- | --- | --- |
| `/admin` が開かない、または無効化と表示される | `ADMIN_TOKEN` 未設定、またはサービス未起動 | 環境変数とサービス状態を確認して再試行する |
| 認証に失敗し続ける | password が `ADMIN_TOKEN` ではない、または header 形式が誤っている | Basic Auth では任意の username と正しい token を使う。必要なら Bearer / `x-admin-token` に切り替える |
| AI update があるのに lookup に出ない | まだ `pending`、source update に上書きされている、または bulk approve が conflict guard に止められている | `/admin/review` で queue / batch 状態を確認し、`Entry Inspector` で effective と source layer を比較する |
| release build 後も内容が切り替わらない | `Build only` を選んで activate していない | `Releases` でその version を activate する。次回は `Build and activate` を使う |
| promote 後に期待したデータが入っていない | AI update が未承認、または promote 時点で effective ではなかった | review 状態を確認し、`Entry Inspector` で effective layer を検証する |
| batch が failed になった | source 条件、model 設定、cost 制限、その他実行エラー | `Jobs` の batch detail で `error` を確認し、修正後に再実行する |
| orphaned word IDs が出ている | update が active release に存在しない単語を指している | `Updates` と `Entry Inspector` で影響範囲を確認する。promote はそれらをスキップするが、rebuild または cleanup を検討する |

### 7. 用語集とルート対応表

| 画面 / 機能 | Route | 主な API | 備考 |
| --- | --- | --- | --- |
| Dashboard | `/admin` | `/admin/api/summary` | システム概要と最近の batch |
| Entry Inspector | `/admin/entry` | `/admin/api/entries` | 1 件の単語を複数レイヤーで確認 |
| Review Queue | `/admin/review` | `/admin/api/review/queue`、legacy `/admin/api/review/ai` | queue summary と最近 batch の入口 |
| Batch Review | `/admin/review/batch/:id` | `/admin/api/review/batches/:id/summary`、`/admin/api/review/units/approve`、`/admin/api/review/units/reject`、単体 approve/reject endpoints | AI review unit の単体/一括審査 |
| New Word | `/admin/new-word` | `/admin/api/new-word`、`/admin/api/new-word/build-release` | snapshot に書き込み、その後 release build が必要 |
| Releases | `/admin/releases` | `/admin/api/releases`、`/admin/api/releases/build`、`/admin/api/releases/:version/activate`、`/admin/api/releases/promote` | build / activate / promote の管理 |
| Jobs | `/admin/jobs` | `/admin/api/jobs/source-update`、`/admin/api/jobs/gemini-import`、`/admin/api/batches/:id` | job 実行と batch 確認 |
| Updates | `/admin/updates` | `/admin/api/updates` | 全体 update の確認 |

### 実装メモ

- この文書は、現在の `New Word` フローを含む、この workspace の実装を意図的にそのまま反映しています。
- コードに存在しない role model、approval layer、automation は記載していません。
- admin UI はまだ変化中のため、保守しやすさを優先して v1 ではスクリーンショットを意図的に省略しています。

## 繁體中文

本手冊依照目前這個 workspace 的 admin 實作撰寫，對象是內部營運與工程團隊。內容涵蓋查詞、AI 審核、發版、工作批次與常見排錯。

### 目錄

- 1. Admin 總覽
- 2. 存取與驗證
- 3. 核心概念
- 4. 日常操作 Runbook
- 5. 頁面逐項說明
- 6. 疑難排解
- 7. 名詞表與路由對照

### 1. Admin 總覽

Admin UI 是內部操作介面，用來處理 release 與 `updates.sqlite` overlay 相關工作。它不是一般使用者功能，也不是具備角色分級的後台。任何持有 `ADMIN_TOKEN` 的人，實際上都擁有完整管理權限。

這個介面目前可做的事包括：

- 檢查單字在 release、source update、AI update、effective lookup 四層的狀態
- 以 queue / batch workflow 審核 AI translation 與 AI example set
- 建立新詞，先寫入 snapshot JSON，再建立新 release 讓新詞生效
- 建立新 release、啟用既有 release、把 effective updates promote 進新 release
- 觸發 source update 與 Gemini import
- 檢查 batch 狀態、查看 batch 內容與錯誤
- 檢查更新統計與 orphaned word IDs

操作原則：

- 先確認自己是在正確環境與正確 active release 上操作
- AI update 在批准前不會影響 lookup
- source update 會自動成為 effective data
- `promote` 只會把目前 effective 的內容烘焙進新 release
- `promote` 遇到 orphaned updates 時會略過它們，而不是讓整個 release build 失敗
- `New Word` 寫入 snapshot 後，還要 build release 才會對 lookup 生效
- `New Word -> Build release` 會從整份目前 snapshot 建立新 release，不會偷偷把 overlay updates 烘進 release

### 2. 存取與驗證

前置條件：

- 服務正在執行，通常是 `bun run dev`
- 環境變數 `ADMIN_TOKEN` 已設定
- 目前環境可讀取 active release 與 `updates.sqlite`
- active release 可能來自 `releases/current.json`，也可能來自 `RELEASE_DB_PATH` 之類的 env override

目前支援的 admin 驗證方式：

- Basic Auth：任意 username，加上 `ADMIN_TOKEN` 當 password
- Bearer token：`Authorization: Bearer <ADMIN_TOKEN>`
- `x-admin-token` header：`x-admin-token: <ADMIN_TOKEN>`

進入方式：

1. 設定 `ADMIN_TOKEN`
2. 啟動服務
3. 開啟 `/admin`
4. 若瀏覽器跳出 Basic Auth 視窗，username 可任填，password 輸入 `ADMIN_TOKEN`

重要限制：

- 若沒有設定 `ADMIN_TOKEN`，admin 會被停用
- 這不是多角色後台，沒有 read-only 權限
- token 持有者可以 build、activate、promote、寫入 snapshot、觸發 job

安全建議：

- 不要把 `ADMIN_TOKEN` 放進截圖、錄影或公開文件
- 不要在共用帳號間長期共用同一 token
- 涉及 `activate`、`promote`、`new word` 的操作前，先確認目標環境

### 3. 核心概念

#### 名詞對照表

| Term | 繁體中文 | English | 日本語 | Meaning |
| --- | --- | --- | --- | --- |
| immutable release | 不可變 release | immutable release | immutable release / 不変 release | A built release DB and manifest that are treated as a frozen snapshot. |
| active release | 目前生效版本 | active release | active release / 現在有効な release | The release currently used as the runtime base. |
| updates overlay | 更新覆蓋層 | updates overlay | updates overlay / 更新 overlay | Incremental data stored in `updates.sqlite` on top of the active release. |
| source update | 來源更新 | source update | source update / ソース更新 | Deterministic imported update. Effective automatically. |
| AI update | AI 更新 | AI update | AI update / AI 更新 | Generated update from Gemini. Requires approval before becoming effective. |
| pending | 待審核 | pending | pending / 審査待ち | AI update exists but is not effective yet. |
| approved | 已批准 | approved | approved / 承認済み | AI update is approved and can become effective. |
| rejected | 已拒絕 | rejected | rejected / 却下済み | AI update was reviewed and rejected. |
| not_required | 不需審核 | not_required | not_required / 審査不要 | Source update state. Review is not required. |
| active | 作用中 | active | active / 有効 | Current update record is still the live candidate. |
| superseded | 已被取代 | superseded | superseded / 置き換え済み | A newer update replaced this one. |
| promoted | 已烘焙進 release | promoted | promoted / release へ反映済み | Update has already been baked into a promoted release. |
| batch | 批次 | batch | batch / バッチ | One source-update or AI-import execution record. |
| effective lookup | 實際查詢結果 | effective lookup | effective lookup / 実効 lookup | What the API returns after combining active release and effective updates. |
| build | 建立 release | build | build / release 作成 | Create a new release from snapshot or effective data. |
| activate | 切換生效版本 | activate | activate / 有効化 | Point runtime to a specific release. |
| promote | 將 effective updates 烘焙進 release | promote | promote / effective updates を release 化 | Create a new release from current effective data and mark included updates as promoted. |

資料流規則：

- runtime base 來自 active release
- active release 由 runtime 解析決定，可能是 managed pointer，也可能是 env override
- `updates.sqlite` 會在查詢時疊加在 active release 上
- source update 自動生效
- AI update 只有在 `approved` 後才會生效
- source update 優先級高於 AI update
- `promote` 只會把目前 effective 的內容帶進新 release

release 動作差異：

- `Build release`: 依照目前 snapshot 建立新 release，可選擇是否立刻 activate
- `New word build release`: 驗證指定的新詞存在於 snapshot，然後仍以整份目前 snapshot 建立新 release
- `Activate release`: 不重建資料，只切換 active pointer
- `Promote release`: 依照目前 effective lookup 狀態建立新 release，並把納入的 update 標記為 `promoted`
- orphaned updates 仍會在 admin / verify 畫面中顯示，但 promote 時不會被寫進新 release

batch 狀態差異：

- `running`: job 仍在進行
- `succeeded`: job 完成
- `failed`: job 失敗，可從 batch detail 查看錯誤

### 4. 日常操作 Runbook

#### 4.1 Sign in and confirm admin availability

- Purpose: 確認 admin 已啟用、登入可用、目前系統可操作。
- Preconditions: 已設定 `ADMIN_TOKEN`，服務已啟動。
- Steps:
  1. 開啟 `/admin`
  2. 完成 Basic Auth 或其他 token 驗證
  3. 確認 Dashboard 能正常顯示 active release 與統計
- Expected result: 可以看到 Dashboard，而不是 401 或 admin disabled 訊息。
- Risks / do not do: 不要在不確定環境時直接進行 release 或 job 操作。
- Recovery: 若失敗，先檢查 `ADMIN_TOKEN`、服務是否啟動、URL 是否正確。
- Engineering notes: 未設定 `ADMIN_TOKEN` 時，admin middleware 會回 disabled 訊息。

#### 4.2 Inspect one word across all layers

- Purpose: 確認某個詞條目前在 release、source、AI、effective 四層的狀態差異。
- Preconditions: 已登入 admin，知道要查的 word 與 language。
- Steps:
  1. 前往 `Entry Inspector`
  2. 輸入 word 與 language
  3. 比較 `Effective Lookup`、`Release Layer`、`Source Update Layer`、`AI Update Layer`
  4. 需要細節時展開 raw JSON
- Expected result: 可判斷目前使用者看到的是 release 還是某個 update 覆蓋後的結果。
- Risks / do not do: 不要只看 AI layer 就假設 lookup 已經改變，還要確認 review 狀態與 effective layer。
- Recovery: 若查不到，先換 reading，再確認該詞是否存在於 active release 或是否剛建立但尚未 build release。
- Engineering notes: source/AI layer 的完整 payload 以 JSON block 呈現，effective 才代表實際 API 查詢結果。

#### 4.3 Review AI translations and example sets

- Purpose: 用 queue / batch workflow 審核 AI candidates，決定哪些內容可進入 effective lookup。
- Preconditions: 已有 pending AI updates，通常來自 Gemini import；知道要先看哪個 batch 或語言。
- Steps:
  1. 前往 `/admin/review` 查看 `Queue Summary`
  2. 先從最新 batch 或高風險 batch 進入 `/admin/review/batch/:id`
  3. 在 batch 頁依 language、risk、shape、source conflict 篩選 review units
  4. 對單一 unit 用卡片上的 `Approve` / `Reject`，或勾選多筆後使用 `Approve selected` / `Reject selected`
  5. 若出現 source conflict，只有在你確認要覆蓋目前 source-effective 結果時才使用 override
- Expected result: `approved` 的 AI update 會變成 effective，`rejected` 不會生效。
- Risks / do not do: 不要把 review 當成發版；批准只會影響 effective lookup，不會自動建立新 release。
- Recovery: 若批准後查詢仍未改變，回到 Entry Inspector 確認是否被 source update 覆蓋、是否查錯語言，或該 unit 是否其實被 bulk action 擋下。
- Engineering notes: `/admin/review` 現在是 queue dashboard，不再只是平面卡片清單；bulk review endpoint 會限制同批次、同語言，並對 source conflict 做保護。

#### 4.4 Create a new word

- Purpose: 在 snapshot 中新增正式詞條，供下一個 release 使用。
- Preconditions: 該詞不應已存在；需準備 word、reading、至少一個 translation。
- Steps:
  1. 前往 `New Word`
  2. 輸入 `Word`、`Reading`、可選的 `Part of speech`、`JLPT`、`Common`
  3. 新增至少一個語言區塊，填入 definitions，必要時加入 examples
  4. 按 `Save new word`
  5. 成功後再去 build release；若同一批還有其他 snapshot 變更，也可以一起等待這次 build
- Expected result: 詞條會寫入 snapshot 檔案，但 lookup 還看不到，直到 release build 完成並啟用。之後的 new-word build-release 會帶入整份目前 snapshot，而不只是一個詞。
- Risks / do not do: 不要把這一步誤認為已發布；不要填非日文讀音；不要重複語言列。
- Recovery: 若回 409，表示重複詞條；若回 400，依欄位錯誤修正。若已建立但 lookup 找不到，請先 build release。
- Engineering notes: 這會寫入 `data/core.json` 與對應 `data/lang/*.json`，definition/example 來源會標成 `manual`。new-word build-release 只用 `createdWordId` 做存在驗證，不會把目前 overlay updates 直接烘進 release。

#### 4.5 Build a new release

- Purpose: 根據目前 snapshot 建立新的 immutable release。
- Preconditions: snapshot 已準備好；若有 New Word，已完成儲存。
- Steps:
  1. 前往 `Releases`
  2. 在 `Build New Release` 輸入 version override，或留空自動產生
  3. 選擇 `Build and activate` 或 `Build only`
  4. 按 `Build release`
- Expected result: 新 release 出現在 Release Inventory；若選 activate，active release 也會更新。
- Risks / do not do: `Build only` 不會切 active pointer；別以為 build 成功就代表使用者已切到新資料。
- Recovery: 若新詞仍查不到，確認這次 build 是否真的 activate 了；若沒有，請再 activate 該版本。
- Engineering notes: build 來自 snapshot，而不是從 effective overlay 反推。若要把目前 effective source/approved AI overlay 永久化，應改走 promote。

#### 4.6 Activate an existing release

- Purpose: 將 runtime 切換到已存在的 release。
- Preconditions: 目標 release 已存在於 Release Inventory。
- Steps:
  1. 前往 `Releases`
  2. 在 Release Inventory 找到目標版本
  3. 觸發該版本的 activate 操作
- Expected result: active release 變成選定版本。
- Risks / do not do: activate 不會合併最新 updates，也不會重新 build。
- Recovery: 若切錯版本，重新 activate 正確版本即可。
- Engineering notes: 這是單純切 pointer，不會改動 snapshot 或 update records。

#### 4.7 Promote effective updates into a release

- Purpose: 把目前 effective 的 source/approved AI updates 烘焙進新 release。
- Preconditions: 需要被納入的 AI update 已經批准。
- Steps:
  1. 前往 `Releases`
  2. 在 `Promote Updates` 選擇 version override 或留空
  3. 選擇 `Promote and activate` 或 `Promote only`
  4. 按 `Promote release`
- Expected result: 新 release 會根據當前 effective 狀態建立，納入的 updates 會被標記為 `promoted`；orphaned updates 會被略過，不會阻塞 promote。
- Risks / do not do: 未批准的 AI update 不會被帶進 promote；不要把 promote 當成單純 activate。
- Recovery: 若預期資料沒進新 release，先確認它是否為 effective data，再檢查 review 狀態與語言。
- Engineering notes: promote 以 active release + effective updates 組出 merged snapshot，再產生新 release。若 update 指向不在 release snapshot 中的 word，它會被視為 orphaned 並在 promote 時略過。

#### 4.8 Run a source update job

- Purpose: 從上游 deterministic source 產生 update records。
- Preconditions: 來源資料與相關環境條件已準備好。
- Steps:
  1. 前往 `Jobs`
  2. 在 `Source Update` 填語言，或留空表示全部/預設範圍
  3. 選擇 `Write updates` 或 `Dry run`
  4. 按 `Run source update`
  5. 到 Batch History 檢查結果
- Expected result: 成功時會產生 batch 與 update records；source updates 會自動成為 effective。
- Risks / do not do: 在不確定來源品質時先用 dry run；source update 可能覆蓋 AI update 的效果。
- Recovery: 若失敗，到 batch detail 看 error；若結果和預期不同，回 Entry Inspector 比對 source layer。
- Engineering notes: source updates 預設不需要 review，effective 優先級高於 AI。

#### 4.9 Run a Gemini import job

- Purpose: 產生 AI translation 與 example candidates，供後續 review。
- Preconditions: Gemini API 條件與對應模型設定可用。
- Steps:
  1. 前往 `Jobs`
  2. 在 `Gemini Import` 設定語言、seed language、model、limit、frequency、cost 等參數
  3. 先用 `Dry run` 驗證範圍
  4. 需要正式寫入時，改用 `Write pending reviews`
  5. 完成後到 `/admin/review` 與 `Batch History` 查看結果
- Expected result: 正式寫入時會建立 pending AI updates，尚未批准前不會進 lookup。
- Risks / do not do: 不要跳過 dry run 就大範圍實跑；不要把寫入 pending reviews 誤認為已發布。
- Recovery: 若批次失敗，先檢查 batch detail；若批次成功但頁面沒東西，確認是否真的有候選資料產生，並檢查語言篩選。
- Engineering notes: Gemini import 寫進 overlay DB，AI updates 預設 review 狀態是 `pending`。

#### 4.10 Inspect batch history and failures

- Purpose: 確認 job 是否成功、失敗在哪裡、實際產生了哪些 update。
- Preconditions: 至少執行過一次 source update 或 Gemini import。
- Steps:
  1. 前往 `Jobs`
  2. 在 `Batch History` 找到目標 batch
  3. 點 batch id 進入 detail
  4. 查看 `kind`、`status`、`actor`、`created/completed`、`error`
  5. 往下看 translation/example update 清單
- Expected result: 可判斷 job 是否成功、失敗原因為何，以及輸出內容是什麼。
- Risks / do not do: 不要只看 succeeded/failed，還要看輸出是否符合預期。
- Recovery: 若 `failed`，先依 error 修正後重跑；若 `succeeded` 但結果不對，回 Entry Inspector 或 Updates page 驗證實際資料。
- Engineering notes: batch 記錄的是一次 job 執行；update records 仍要結合 review/effective 狀態一起判讀。

### 5. 頁面逐項說明

| Page | 這頁給誰用 | 主要欄位與按鈕 | 何時使用 | 常見誤用 | 對應 API / 行為 |
| --- | --- | --- | --- | --- | --- |
| Dashboard | 營運、工程 | 指標卡、Recent Batches、Quick Actions | 先確認系統整體狀態時 | 只看總數，不回到細節頁驗證 | `/admin/api/summary` |
| Entry Inspector | 營運、工程 | Word、Language、raw JSON | 查某個詞目前實際狀態時 | 把 AI layer 當成已生效結果 | `/admin/api/entries` |
| Review Queue | 營運主用，工程支援 | Queue Summary、batch links、filters、single/bulk approve/reject | 審核 AI 候選內容時 | 以為 approve 等於發版，或忽略 source conflict 保護 | `/admin/api/review/queue`、`/admin/api/review/batches/:id/summary`、`/admin/api/review/units/*`、legacy `/admin/api/review/ai` |
| New Word | 內容維護者、工程 | Core Fields、Translations、Save new word | 補正式新詞時 | 建立後沒 build release 就直接查 lookup | `/admin/api/new-word`、`/admin/api/new-word/build-release` |
| Releases | 營運、工程 | Build release、Promote release、activate action | 管理 release 生命周期時 | 混淆 build、activate、promote | `/admin/api/releases*` |
| Jobs | 營運、工程 | Source Update、Gemini Import、Batch History | 執行批次任務與看結果時 | 不先 dry run 就大範圍實跑 | `/admin/api/jobs/*`、`/admin/api/batches/:id` |
| Updates | 工程主用，營運可查 | Language/Source/Review filters、update cards、verification summary | 要看全域更新狀況時 | 忽略 review 與 sourceType 差異 | `/admin/api/updates` |

### 6. 疑難排解

| 問題 | 常見原因 | 建議處理 |
| --- | --- | --- |
| `/admin` 打不開或顯示未啟用 | `ADMIN_TOKEN` 未設定，或服務未啟動 | 先確認環境變數與服務狀態，再重試 |
| 認證一直失敗 | password 不是 `ADMIN_TOKEN`，header 格式錯誤 | Basic Auth 改用任意 username + 正確 token，或改用 Bearer / `x-admin-token` |
| AI update 已產生但 lookup 看不到 | 仍是 `pending`，被 source update 覆蓋，或 bulk approve 被 conflict guard 擋下 | 到 `/admin/review` 檢查 queue / batch 狀態，再用 `Entry Inspector` 比對 effective 與 source layer |
| build release 後內容沒切換 | 選了 `Build only`，沒有 activate | 到 `Releases` 對該版本執行 activate，或下次直接選 `Build and activate` |
| promote 後預期資料沒進新 release | AI update 未批准，或 promote 時該資料不是 effective | 先確認 review 狀態，再回 `Entry Inspector` 驗證 effective layer |
| batch failed | 來源條件、模型、成本限制或其他執行錯誤 | 在 `Jobs` 的 batch detail 查看 `error`，修正後重跑 |
| 出現 orphaned word IDs | update 指向的 word 已不在 active release 中 | 先在 `Updates` 與 `Entry Inspector` 查明影響範圍。promote 會略過這些 rows，但仍應決定是否重建或清理資料 |

### 7. 名詞表與路由對照

| 頁面 / 功能 | Route | 主要 API | 備註 |
| --- | --- | --- | --- |
| Dashboard | `/admin` | `/admin/api/summary` | 系統總覽與最近 batch |
| Entry Inspector | `/admin/entry` | `/admin/api/entries` | 查單字多層資料 |
| Review Queue | `/admin/review` | `/admin/api/review/queue`、legacy `/admin/api/review/ai` | queue summary 與最近批次入口 |
| Batch Review | `/admin/review/batch/:id` | `/admin/api/review/batches/:id/summary`、`/admin/api/review/units/approve`、`/admin/api/review/units/reject`、單筆 approve/reject endpoints | 單筆或批次審核 AI review units |
| New Word | `/admin/new-word` | `/admin/api/new-word`、`/admin/api/new-word/build-release` | 先寫 snapshot，再 build release |
| Releases | `/admin/releases` | `/admin/api/releases`、`/admin/api/releases/build`、`/admin/api/releases/:version/activate`、`/admin/api/releases/promote` | build / activate / promote |
| Jobs | `/admin/jobs` | `/admin/api/jobs/source-update`、`/admin/api/jobs/gemini-import`、`/admin/api/batches/:id` | 執行 job 與看 batch |
| Updates | `/admin/updates` | `/admin/api/updates` | 全域 update 檢視 |

### 實作說明

- 本文件刻意以目前 workspace 的實作為準，包括現在的 `New Word` 流程。
- 文件不描述程式碼中尚未存在的角色模型、審批層或自動化機制。
- 由於 admin UI 仍在演進中，v1 刻意不放截圖，以維持文件可維護性。

