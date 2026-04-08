import type {
  AdminBatchDetailResponse,
  AdminEntryInspectionResponse,
  AdminReleaseListResponse,
  AdminReviewQueueResponse,
  AdminSummaryResponse,
  AdminUpdatesResponse,
} from './types'
import type { Language } from '../types'
import type { ReleaseListItem } from '../release-service'
import type { ListedExampleUpdateSet, ListedTranslationUpdate, UpdateBatchRecord } from '../update-store'

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function jsonBlock(value: unknown): string {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`
}

function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg: #f7f4ec;
        --panel: rgba(255,255,255,0.82);
        --panel-strong: #fffdf8;
        --text: #1f1a16;
        --muted: #6d6258;
        --line: #d7cdc1;
        --accent: #a64b2a;
        --accent-soft: #f2d7c4;
        --good: #265d45;
        --warn: #8b5a10;
        --bad: #8f2f2f;
        --shadow: 0 18px 50px rgba(55, 33, 13, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(166, 75, 42, 0.12), transparent 35%),
          linear-gradient(180deg, #faf7f1 0%, var(--bg) 100%);
      }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      code, pre, input, select, button, textarea { font-family: "SFMono-Regular", Consolas, monospace; }
      .shell {
        max-width: 1320px;
        margin: 0 auto;
        padding: 24px;
      }
      .hero {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: end;
        margin-bottom: 24px;
      }
      .hero h1 {
        margin: 0;
        font-size: 34px;
        line-height: 1.05;
      }
      .hero p {
        margin: 8px 0 0;
        color: var(--muted);
        max-width: 780px;
      }
      nav {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      nav a {
        padding: 8px 12px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: rgba(255,255,255,0.7);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid rgba(125, 108, 90, 0.18);
        border-radius: 18px;
        box-shadow: var(--shadow);
        padding: 18px;
        backdrop-filter: blur(8px);
      }
      .panel h2, .panel h3 {
        margin: 0 0 10px;
        font-size: 18px;
      }
      .metric {
        font-size: 28px;
        font-weight: 700;
      }
      .muted { color: var(--muted); }
      .two-col {
        display: grid;
        grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.9fr);
        gap: 16px;
        margin-top: 16px;
      }
      .stack { display: grid; gap: 16px; }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }
      th, td {
        padding: 10px 8px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      th { color: var(--muted); font-weight: 600; }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
        border: 1px solid transparent;
        white-space: nowrap;
      }
      .badge.active, .badge.approved, .badge.succeeded, .badge.source, .badge.not_required {
        background: rgba(38, 93, 69, 0.12);
        color: var(--good);
        border-color: rgba(38, 93, 69, 0.18);
      }
      .badge.pending, .badge.running {
        background: rgba(139, 90, 16, 0.12);
        color: var(--warn);
        border-color: rgba(139, 90, 16, 0.18);
      }
      .badge.failed, .badge.rejected, .badge.superseded {
        background: rgba(143, 47, 47, 0.12);
        color: var(--bad);
        border-color: rgba(143, 47, 47, 0.18);
      }
      .badge.promoted, .badge.ai {
        background: var(--accent-soft);
        color: var(--accent);
        border-color: rgba(166, 75, 42, 0.24);
      }
      form {
        display: grid;
        gap: 10px;
      }
      .inline-form {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: end;
      }
      label {
        display: grid;
        gap: 6px;
        font-size: 13px;
        color: var(--muted);
      }
      input, select, textarea, button {
        font-size: 14px;
        border-radius: 10px;
        border: 1px solid var(--line);
        padding: 10px 12px;
        background: var(--panel-strong);
        color: var(--text);
      }
      textarea { min-height: 110px; resize: vertical; }
      button {
        cursor: pointer;
        background: linear-gradient(180deg, #b75935 0%, #8f4024 100%);
        color: white;
        border: none;
      }
      button.secondary {
        background: #ede5db;
        color: var(--text);
        border: 1px solid var(--line);
      }
      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .callout {
        padding: 12px 14px;
        border-radius: 12px;
        background: rgba(166, 75, 42, 0.08);
        border: 1px solid rgba(166, 75, 42, 0.18);
      }
      .empty {
        padding: 24px;
        border: 1px dashed var(--line);
        border-radius: 16px;
        color: var(--muted);
      }
      pre {
        margin: 0;
        overflow: auto;
        background: #201912;
        color: #f3ecdf;
        padding: 14px;
        border-radius: 14px;
        font-size: 12px;
      }
      .list {
        display: grid;
        gap: 14px;
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 16px;
        background: rgba(255,255,255,0.72);
      }
      .card h3 { margin-bottom: 8px; }
      .split {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 12px;
      }
      .result {
        margin-top: 12px;
        display: none;
      }
      .result.visible { display: block; }
      @media (max-width: 900px) {
        .two-col { grid-template-columns: 1fr; }
        .hero { flex-direction: column; align-items: start; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="hero">
        <div>
          <h1>Yori Admin</h1>
          <p>Inspect immutable releases, review AI overlay updates, and drive release operations without changing the runtime data model.</p>
        </div>
        <nav>
          <a href="/admin">Dashboard</a>
          <a href="/admin/entry">Entry Inspector</a>
          <a href="/admin/review">AI Review</a>
          <a href="/admin/updates">Updates Explorer</a>
          <a href="/admin/releases">Releases</a>
          <a href="/admin/jobs">Jobs</a>
        </nav>
      </div>
      ${body}
    </div>
    <script>
      async function submitJsonForm(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const result = form.querySelector('[data-result]');
        const submitter = event.submitter;
        if (submitter && submitter.dataset.confirm) {
          if (!window.confirm(submitter.dataset.confirm)) return;
        }
        const formData = new FormData(form);
        const payload = {};
        for (const [key, value] of formData.entries()) {
          if (value === '') continue;
          if (payload[key] !== undefined) {
            if (!Array.isArray(payload[key])) payload[key] = [payload[key]];
            payload[key].push(value);
          } else {
            payload[key] = value;
          }
        }
        for (const key of Object.keys(payload)) {
          if (payload[key] === 'true') payload[key] = true;
          else if (payload[key] === 'false') payload[key] = false;
          else if (typeof payload[key] === 'string' && /^\\d+$/.test(payload[key])) payload[key] = Number(payload[key]);
        }
        try {
          const action = submitter && submitter.formAction ? submitter.formAction : form.action;
          const method = submitter && submitter.formMethod ? submitter.formMethod : (form.method || 'POST');
          const res = await fetch(action, {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const text = await res.text();
          if (result) {
            result.textContent = text;
            result.classList.add('visible');
          }
          if (res.ok && form.dataset.reload === 'true') {
            window.location.reload();
          }
        } catch (error) {
          if (result) {
            result.textContent = String(error);
            result.classList.add('visible');
          }
        }
      }
      for (const form of document.querySelectorAll('form[data-json-form="true"]')) {
        form.addEventListener('submit', submitJsonForm);
      }
    </script>
  </body>
</html>`
}

function renderBadge(value: string): string {
  return `<span class="badge ${escapeHtml(value)}">${escapeHtml(value)}</span>`
}

function renderBatchTable(batches: UpdateBatchRecord[]): string {
  if (batches.length === 0) return '<div class="empty">No batches yet.</div>'
  return `<table>
    <thead><tr><th>ID</th><th>Kind</th><th>Status</th><th>Actor</th><th>Created</th><th>Notes</th></tr></thead>
    <tbody>
      ${batches.map((batch) => `
        <tr>
          <td><a href="/admin/jobs?batchId=${batch.id}">${batch.id}</a></td>
          <td>${escapeHtml(batch.kind)}</td>
          <td>${renderBadge(batch.status)}</td>
          <td>${escapeHtml(batch.actor ?? 'system')}</td>
          <td>${escapeHtml(batch.createdAt)}</td>
          <td>${escapeHtml(batch.notes ?? '')}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>`
}

function renderReleaseTable(releases: ReleaseListItem[]): string {
  if (releases.length === 0) return '<div class="empty">No releases found.</div>'
  return `<table>
    <thead><tr><th>Version</th><th>Built</th><th>Schema</th><th>Source Fingerprint</th><th>Promoted From</th><th>State</th></tr></thead>
    <tbody>
      ${releases.map((release) => `
        <tr>
          <td>${escapeHtml(release.version)}</td>
          <td>${escapeHtml(release.builtAt)}</td>
          <td>${escapeHtml(release.schemaVersion)}</td>
          <td><code>${escapeHtml(release.baseSourceFingerprint)}</code></td>
          <td>${escapeHtml(release.promotedFromUpdateSequence ?? 'n/a')}</td>
          <td>${release.isActive ? renderBadge('active') : renderBadge('inactive')}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>`
}

function renderTranslationCards(items: ListedTranslationUpdate[]): string {
  if (items.length === 0) return '<div class="empty">No translation updates match this view.</div>'
  return `<div class="list">
    ${items.map((item) => `
      <div class="card">
        <h3>${escapeHtml(item.wordId)} <span class="muted">(${escapeHtml(item.lang)})</span></h3>
        <div class="actions">
          ${renderBadge(item.sourceType)}
          ${renderBadge(item.status)}
          ${renderBadge(item.reviewStatus)}
          <span class="badge">${escapeHtml(`batch:${item.batchId}`)}</span>
        </div>
        <div class="split" style="margin-top:12px">
          <div>
            <strong>Definitions</strong>
            <ul>${item.definitions.map((definition) => `<li>${escapeHtml(definition)}</li>`).join('')}</ul>
          </div>
          <div>
            <strong>Sources</strong>
            <ul>${item.sources.map((source) => `<li>${escapeHtml(source)}</li>`).join('')}</ul>
          </div>
        </div>
        <div class="muted">Created ${escapeHtml(item.createdAt)} by batch ${item.batchId}</div>
      </div>
    `).join('')}
  </div>`
}

function renderExampleCards(items: ListedExampleUpdateSet[]): string {
  if (items.length === 0) return '<div class="empty">No example update sets match this view.</div>'
  return `<div class="list">
    ${items.map((item) => `
      <div class="card">
        <h3>${escapeHtml(item.wordId)} <span class="muted">(${escapeHtml(item.lang)})</span></h3>
        <div class="actions">
          ${renderBadge(item.sourceType)}
          ${renderBadge(item.status)}
          ${renderBadge(item.reviewStatus)}
          <span class="badge">${escapeHtml(`batch:${item.batchId}`)}</span>
        </div>
        <table style="margin-top:12px">
          <thead><tr><th>Japanese</th><th>Translation</th><th>Source</th></tr></thead>
          <tbody>
            ${item.examples.map((example) => `
              <tr>
                <td>${escapeHtml(example.japanese)}</td>
                <td>${escapeHtml(example.translation)}</td>
                <td>${escapeHtml(example.source)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `).join('')}
  </div>`
}

export function renderDashboardPage(data: AdminSummaryResponse): string {
  return renderPage('Dashboard', `
    <div class="grid">
      <div class="panel"><h2>Active Release</h2><div class="metric">${escapeHtml(data.activeReleaseVersion)}</div><div class="muted">mode: ${escapeHtml(data.activeReleaseMode)}</div></div>
      <div class="panel"><h2>Pending AI Review</h2><div class="metric">${escapeHtml((data.reviewCounts['translation:pending'] ?? 0) + (data.reviewCounts['example:pending'] ?? 0))}</div></div>
      <div class="panel"><h2>Orphaned Updates</h2><div class="metric">${escapeHtml(data.orphanedWordIdsCount)}</div></div>
      <div class="panel"><h2>Active Reviewed AI</h2><div class="metric">${escapeHtml(data.activeReviewedAiCount)}</div></div>
    </div>
    <div class="two-col">
      <div class="stack">
        <div class="panel">
          <h2>Status Counts</h2>
          ${jsonBlock({
            translations: data.translationCounts,
            exampleSets: data.exampleSetCounts,
            reviews: data.reviewCounts,
          })}
        </div>
        <div class="panel">
          <h2>Recent Batches</h2>
          ${renderBatchTable(data.recentBatches)}
        </div>
      </div>
      <div class="stack">
        <div class="panel">
          <h2>Quick Links</h2>
          <div class="list">
            <div class="callout">Use <a href="/admin/entry">Entry Inspector</a> to compare release, source update, AI update, and final effective lookup.</div>
            <div class="callout">Use <a href="/admin/review">AI Review</a> to approve or reject pending AI overlays.</div>
            <div class="callout">Use <a href="/admin/releases">Releases</a> to build, activate, and promote immutable snapshots.</div>
            <div class="callout">Use <a href="/admin/jobs">Jobs</a> to trigger deterministic source updates or Gemini imports.</div>
          </div>
        </div>
      </div>
    </div>
  `)
}

export function renderEntryPage(data: AdminEntryInspectionResponse): string {
  const word = data.word
  return renderPage('Entry Inspector', `
    <div class="panel">
      <h2>Lookup an entry</h2>
      <form method="GET" action="/admin/entry" class="inline-form">
        <label>Word
          <input type="text" name="word" value="${escapeHtml(data.query.word)}" placeholder="食べる" />
        </label>
        <label>Language
          <select name="lang">
            ${(['en', 'de', 'ko', 'zh-cn', 'zh-tw'] as Language[]).map((lang) => `
              <option value="${lang}" ${data.query.lang === lang ? 'selected' : ''}>${lang}</option>
            `).join('')}
          </select>
        </label>
        <button type="submit">Inspect</button>
      </form>
    </div>
    ${word ? `
      <div class="two-col">
        <div class="stack">
          <div class="panel">
            <h2>Release Word</h2>
            ${jsonBlock(word)}
          </div>
          <div class="panel">
            <h2>Release Layer</h2>
            ${jsonBlock(data.release)}
          </div>
          <div class="panel">
            <h2>Source Update Layer</h2>
            ${jsonBlock(data.sourceUpdate)}
          </div>
          <div class="panel">
            <h2>AI Update Layer</h2>
            ${jsonBlock(data.aiUpdate)}
          </div>
        </div>
        <div class="stack">
          <div class="panel">
            <h2>Effective Lookup</h2>
            ${jsonBlock(data.effective)}
          </div>
          <div class="panel">
            <h2>Precedence Notes</h2>
            <div class="callout">Release provides the base word record. Source updates override AI. Pending or rejected AI entries remain visible here but do not affect the effective lookup.</div>
          </div>
        </div>
      </div>
    ` : `<div class="panel empty">No matching release word found for this query.</div>`}
  `)
}

export function renderReviewPage(data: AdminReviewQueueResponse): string {
  return renderPage('AI Review Queue', `
    <div class="panel">
      <h2>Pending AI Reviews</h2>
      <div class="muted">Active release: ${escapeHtml(data.releaseVersion)}</div>
      <p class="muted">Only approved AI updates become visible to lookup. Source updates remain automatically effective.</p>
    </div>
    <div class="two-col">
      <div class="panel">
        <h2>Translation Candidates</h2>
        ${data.translations.length === 0 ? '<div class="empty">No pending AI translation reviews.</div>' : data.translations.map((item) => `
          <div class="card">
            <h3>${escapeHtml(item.wordId)} <span class="muted">(${escapeHtml(item.lang)})</span></h3>
            <div class="actions">${renderBadge(item.status)} ${renderBadge(item.reviewStatus)} ${renderBadge(item.sourceType)}</div>
            <ul>${item.definitions.map((definition) => `<li>${escapeHtml(definition)}</li>`).join('')}</ul>
            <div class="muted">Sources: ${escapeHtml(item.sources.join(', '))}</div>
            <form action="/admin/api/review/translation/${item.id}/approve" method="POST" data-json-form="true" data-reload="true" class="inline-form" style="margin-top:12px">
              <button type="submit">Approve</button>
              <button type="submit" class="secondary" formaction="/admin/api/review/translation/${item.id}/reject">Reject</button>
              <div class="result" data-result></div>
            </form>
          </div>
        `).join('')}
      </div>
      <div class="panel">
        <h2>Example Set Candidates</h2>
        ${data.exampleSets.length === 0 ? '<div class="empty">No pending AI example reviews.</div>' : data.exampleSets.map((item) => `
          <div class="card">
            <h3>${escapeHtml(item.wordId)} <span class="muted">(${escapeHtml(item.lang)})</span></h3>
            <div class="actions">${renderBadge(item.status)} ${renderBadge(item.reviewStatus)} ${renderBadge(item.sourceType)}</div>
            <table style="margin-top:12px">
              <thead><tr><th>Japanese</th><th>Translation</th></tr></thead>
              <tbody>
                ${item.examples.map((example) => `
                  <tr><td>${escapeHtml(example.japanese)}</td><td>${escapeHtml(example.translation)}</td></tr>
                `).join('')}
              </tbody>
            </table>
            <form action="/admin/api/review/example-set/${item.id}/approve" method="POST" data-json-form="true" data-reload="true" class="inline-form" style="margin-top:12px">
              <button type="submit">Approve</button>
              <button type="submit" class="secondary" formaction="/admin/api/review/example-set/${item.id}/reject">Reject</button>
              <div class="result" data-result></div>
            </form>
          </div>
        `).join('')}
      </div>
    </div>
  `)
}

export function renderReleasesPage(data: AdminReleaseListResponse): string {
  return renderPage('Releases', `
    <div class="two-col">
      <div class="stack">
        <div class="panel">
          <h2>Build New Release</h2>
          <form action="/admin/api/releases/build" method="POST" data-json-form="true" data-reload="true">
            <label>Version override
              <input type="text" name="version" placeholder="optional" />
            </label>
            <label>
              <select name="activate">
                <option value="true">Build and activate</option>
                <option value="false">Build only</option>
              </select>
            </label>
            <button type="submit">Build release</button>
            <div class="result" data-result></div>
          </form>
        </div>
        <div class="panel">
          <h2>Promote Active Updates</h2>
          <form action="/admin/api/releases/promote" method="POST" data-json-form="true" data-reload="true">
            <label>Version override
              <input type="text" name="version" placeholder="optional" />
            </label>
            <label>
              <select name="activate">
                <option value="true">Promote and activate</option>
                <option value="false">Promote only</option>
              </select>
            </label>
            <button type="submit" data-confirm="Promote current effective updates into a new release?">Promote release</button>
            <div class="result" data-result></div>
          </form>
        </div>
      </div>
      <div class="panel">
        <h2>Release Inventory</h2>
        <div class="muted">Active release: ${escapeHtml(data.activeReleaseVersion)}</div>
        ${renderReleaseTable(data.releases)}
        <div class="list" style="margin-top:16px">
          ${data.releases.map((release) => release.isActive ? '' : `
            <form action="/admin/api/releases/${escapeHtml(release.version)}/activate" method="POST" data-json-form="true" data-reload="true" class="inline-form">
              <span>${escapeHtml(release.version)}</span>
              <button type="submit" class="secondary">Activate</button>
              <div class="result" data-result></div>
            </form>
          `).join('')}
        </div>
      </div>
    </div>
  `)
}

export function renderJobsPage(
  batches: UpdateBatchRecord[],
  batchDetail: AdminBatchDetailResponse | null
): string {
  return renderPage('Jobs', `
    <div class="two-col">
      <div class="stack">
        <div class="panel">
          <h2>Run Deterministic Source Update</h2>
          <form action="/admin/api/jobs/source-update" method="POST" data-json-form="true">
            <label>Languages
              <input type="text" name="langs" placeholder="en,de,ko,zh-cn,zh-tw" />
            </label>
            <label>
              <select name="dryRun">
                <option value="false">Write updates</option>
                <option value="true">Dry run</option>
              </select>
            </label>
            <button type="submit">Run source update</button>
            <div class="result" data-result></div>
          </form>
        </div>
        <div class="panel">
          <h2>Run Gemini Import</h2>
          <form action="/admin/api/jobs/gemini-import" method="POST" data-json-form="true">
            <label>Languages
              <input type="text" name="langs" value="de,ko,zh-cn,zh-tw" />
            </label>
            <label>Seed language
              <input type="text" name="seedLang" value="en" />
            </label>
            <label>Model
              <input type="text" name="model" value="gemini-3.1-flash-lite-preview" />
            </label>
            <label>Limit
              <input type="text" name="limit" value="100" />
            </label>
            <label>Min frequency
              <input type="text" name="minFrequency" value="10000" />
            </label>
            <label>
              <select name="commonOnly">
                <option value="true">Common only</option>
                <option value="false">All entries</option>
              </select>
            </label>
            <label>Max cost USD
              <input type="text" name="maxCostUsd" value="2" />
            </label>
            <label>
              <select name="dryRun">
                <option value="true">Dry run</option>
                <option value="false">Write pending reviews</option>
              </select>
            </label>
            <button type="submit">Run Gemini import</button>
            <div class="result" data-result></div>
          </form>
        </div>
      </div>
      <div class="stack">
        <div class="panel">
          <h2>Recent Batches</h2>
          ${renderBatchTable(batches)}
        </div>
        ${batchDetail ? `
          <div class="panel">
            <h2>Batch ${batchDetail.batch?.id ?? 'n/a'} Detail</h2>
            ${jsonBlock(batchDetail.batch)}
            <h3 style="margin-top:16px">Translation updates</h3>
            ${renderTranslationCards(batchDetail.translations)}
            <h3 style="margin-top:16px">Example update sets</h3>
            ${renderExampleCards(batchDetail.exampleSets)}
          </div>
        ` : ''}
      </div>
    </div>
  `)
}

export function renderUpdatesPage(data: AdminUpdatesResponse): string {
  return renderPage('Updates Explorer', `
    <div class="panel">
      <h2>Updates Explorer</h2>
      <div class="muted">Active release: ${escapeHtml(data.releaseVersion)}</div>
      <div class="callout" style="margin-top:12px">Use query params such as <code>?lang=zh-tw&amp;sourceType=ai&amp;reviewStatus=pending</code> to narrow the view.</div>
    </div>
    <div class="two-col">
      <div class="panel">
        <h2>Translation Updates</h2>
        ${renderTranslationCards(data.translations)}
      </div>
      <div class="panel">
        <h2>Example Update Sets</h2>
        ${renderExampleCards(data.exampleSets)}
      </div>
    </div>
    <div class="panel" style="margin-top:16px">
      <h2>Verification Snapshot</h2>
      ${jsonBlock(data.verification)}
    </div>
  `)
}
