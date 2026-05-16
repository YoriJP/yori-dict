import type {
  AdminBatchDetailResponse,
  AdminEntryInspectionResponse,
  AdminNewWordResponse,
  AdminReviewBatchSummaryResponse,
  AdminReviewBatchPageResponse,
  AdminReleaseListResponse,
  AdminReviewQueueResponseV2,
  AdminReviewQueueResponse,
  AdminSummaryResponse,
  AdminUpdatesResponse,
  ReviewQueueSummaryRecentBatch,
  ReviewRiskLevel,
  ReviewUnit,
  ReviewUnitReleaseValue,
  ReviewUnitShape,
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

function jsonBlock(value: unknown, label = 'View raw JSON'): string {
  return `<details class="json-details">
    <summary>${escapeHtml(label)}</summary>
    <pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>
  </details>`
}

function formatTimestamp(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const month = months[d.getMonth()]
    const day = d.getDate()
    const year = d.getFullYear()
    const hours = String(d.getHours()).padStart(2, '0')
    const mins = String(d.getMinutes()).padStart(2, '0')
    return `${month} ${day}, ${year} ${hours}:${mins}`
  } catch {
    return escapeHtml(iso)
  }
}

function renderDefinitionList(data: Record<string, number>): string {
  const entries = Object.entries(data)
  if (entries.length === 0) return '<span class="text-muted">none</span>'
  return `<dl class="stat-list">
    ${entries.map(([key, val]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(val)}</dd>`).join('')}
  </dl>`
}

function renderFilterBar(current: { lang?: string | null, sourceType?: string | null, status?: string | null, reviewStatus?: string | null }): string {
  const langs: Language[] = ['en', 'de', 'ko', 'zh-cn', 'zh-tw']
  const sourceTypes = ['source', 'ai']
  const reviewStatuses = ['not_required', 'pending', 'approved', 'rejected']
  return `<form method="GET" action="/admin/updates" class="filter-bar">
    <label>Language
      <select name="lang">
        <option value="">All</option>
        ${langs.map((l) => `<option value="${l}" ${current.lang === l ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </label>
    <label>Source
      <select name="sourceType">
        <option value="">All</option>
        ${sourceTypes.map((s) => `<option value="${s}" ${current.sourceType === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </label>
    <label>Review
      <select name="reviewStatus">
        <option value="">All</option>
        ${reviewStatuses.map((r) => `<option value="${r}" ${current.reviewStatus === r ? 'selected' : ''}>${r}</option>`).join('')}
      </select>
    </label>
    <button type="submit">Filter</button>
  </form>`
}

const NAV_ITEMS = [
  { href: '/admin', label: 'Dashboard', match: 'Dashboard' },
  { href: '/admin/entry', label: 'Entry Inspector', match: 'Entry' },
  { href: '/admin/review', label: 'AI Review', match: 'Review' },
  { href: '/admin/new-word', label: 'New Word', match: 'New Word' },
  { href: '/admin/updates', label: 'Updates', match: 'Updates' },
  { href: '/admin/releases', label: 'Releases', match: 'Release' },
  { href: '/admin/jobs', label: 'Jobs', match: 'Jobs' },
]

type RenderPageOptions = {
  includeScripts?: boolean
  standalone?: boolean
  utilityHtml?: string
}

function renderPage(title: string, body: string, options: RenderPageOptions = {}): string {
  const includeScripts = options.includeScripts ?? true
  const standalone = options.standalone ?? false
  const navHtml = NAV_ITEMS.map(item =>
    `<a href="${item.href}" ${title.includes(item.match) ? 'aria-current="page"' : ''}>${item.label}</a>`
  ).join('\n          ')
  const utilityHtml = options.utilityHtml ?? `
    <div class="content-header">
      <form action="/admin/logout" method="POST" class="shell-utility-form">
        <button type="submit" class="secondary sm">Log out</button>
      </form>
    </div>
  `

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(title)} — Yori Admin</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;400;700&family=Source+Sans+3:wght@300;400;600&family=JetBrains+Mono:wght@400;500&family=Noto+Sans+JP:wght@400;700&family=Noto+Sans+KR:wght@400;700&family=Noto+Sans+SC:wght@400;700&family=Noto+Sans+TC:wght@400;700&display=swap" rel="stylesheet" />
    <style>
      :root {
        --hue: 45;

        --surface-0: oklch(97% 0.008 var(--hue));
        --surface-1: oklch(94.5% 0.012 var(--hue));
        --surface-2: oklch(99% 0.005 var(--hue));
        --surface-code: oklch(18% 0.015 var(--hue));
        --surface-sidebar: oklch(20% 0.02 var(--hue));

        --text-primary: oklch(22% 0.02 var(--hue));
        --text-secondary: oklch(45% 0.03 var(--hue));
        --text-tertiary: oklch(58% 0.025 var(--hue));
        --text-on-dark: oklch(92% 0.008 var(--hue));
        --text-on-code: oklch(92% 0.015 var(--hue));

        --accent: oklch(52% 0.16 var(--hue));
        --accent-hover: oklch(46% 0.17 var(--hue));
        --accent-subtle: oklch(93% 0.035 var(--hue));

        --positive: oklch(45% 0.12 155);
        --positive-subtle: oklch(95% 0.025 155);
        --caution: oklch(52% 0.12 85);
        --caution-subtle: oklch(95% 0.03 85);
        --negative: oklch(48% 0.14 25);
        --negative-subtle: oklch(95% 0.025 25);
        --info: oklch(52% 0.1 var(--hue));
        --info-subtle: oklch(94% 0.03 var(--hue));

        --border: oklch(89% 0.01 var(--hue));
        --border-strong: oklch(78% 0.018 var(--hue));

        --text-xs: 0.75rem;
        --text-sm: 0.875rem;
        --text-base: 1rem;
        --text-lg: 1.25rem;
        --text-xl: 1.75rem;
        --text-2xl: 2.25rem;

        --font-display: "Fraunces", "Noto Serif JP", "Noto Serif KR", serif;
        --font-body: "Source Sans 3", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", "Noto Sans TC", system-ui, sans-serif;
        --font-mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        --font-jp: "Noto Sans JP", "Noto Sans SC", "Noto Sans TC", "Noto Sans KR", sans-serif;

        --space-1: 4px;
        --space-2: 8px;
        --space-3: 12px;
        --space-4: 16px;
        --space-5: 24px;
        --space-6: 32px;
        --space-7: 48px;
        --space-8: 64px;

        --radius-sm: 3px;
        --radius-md: 6px;

        --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
      }

      *, *::before, *::after { box-sizing: border-box; margin: 0; }

      body {
        font-family: var(--font-body);
        font-size: var(--text-base);
        color: var(--text-primary);
        background: var(--surface-0);
        line-height: 1.55;
        font-kerning: normal;
        font-optical-sizing: auto;
        -webkit-font-smoothing: antialiased;
      }
      body.standalone-body {
        min-height: 100vh;
        background: var(--surface-0);
      }

      /* -- Layout shell -- */
      .shell {
        display: grid;
        grid-template-columns: 200px 1fr;
        min-height: 100vh;
      }

      .sidebar {
        background: var(--surface-sidebar);
        padding: var(--space-6) 0;
        position: sticky;
        top: 0;
        height: 100vh;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
      }
      .sidebar-brand {
        font-family: var(--font-display);
        font-size: var(--text-lg);
        font-weight: 700;
        color: var(--text-on-dark);
        padding: 0 var(--space-5);
        margin-bottom: var(--space-7);
        letter-spacing: -0.02em;
        line-height: 1;
      }
      .sidebar-brand span {
        font-family: var(--font-body);
        font-weight: 400;
        font-size: var(--text-xs);
        display: block;
        color: oklch(55% 0.02 var(--hue));
        margin-top: var(--space-2);
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .sidebar nav {
        display: flex;
        flex-direction: column;
        gap: 1px;
        flex: 1;
      }
      .sidebar nav a {
        display: block;
        padding: var(--space-2) var(--space-5);
        color: oklch(65% 0.015 var(--hue));
        text-decoration: none;
        font-size: var(--text-sm);
        font-weight: 400;
        transition: color 100ms var(--ease-out), background 100ms var(--ease-out);
      }
      .sidebar nav a:hover {
        color: var(--text-on-dark);
        background: oklch(26% 0.018 var(--hue));
      }
      .sidebar nav a[aria-current="page"] {
        color: var(--text-on-dark);
        background: oklch(26% 0.022 var(--hue));
        font-weight: 600;
      }

      .mobile-toggle {
        display: none;
        position: fixed;
        top: var(--space-3);
        left: var(--space-3);
        z-index: 100;
        background: var(--surface-sidebar);
        color: var(--text-on-dark);
        border: none;
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-3);
        font-family: var(--font-body);
        font-size: var(--text-sm);
        cursor: pointer;
      }

      .content {
        padding: var(--space-7) var(--space-7) var(--space-8);
        max-width: 960px;
      }
      .content-header {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--space-4);
        margin-bottom: var(--space-5);
        padding-bottom: var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .shell-utility-form {
        display: block;
      }

      /* -- Typography -- */
      h1, h2, h3, h4 {
        font-family: var(--font-display);
        line-height: 1.15;
        letter-spacing: -0.02em;
        text-wrap: balance;
      }
      h1 {
        font-size: var(--text-2xl);
        font-weight: 700;
        margin-bottom: var(--space-1);
      }
      h2 {
        font-size: var(--text-lg);
        font-weight: 700;
        margin-bottom: var(--space-4);
      }
      h3 {
        font-family: var(--font-body);
        font-size: var(--text-sm);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
        margin-bottom: var(--space-3);
      }

      .page-header {
        margin-bottom: var(--space-6);
      }
      .page-header p {
        color: var(--text-secondary);
        font-size: var(--text-sm);
        max-width: 50ch;
        margin-top: var(--space-2);
      }
      .page-header .page-meta {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin-top: var(--space-1);
      }

      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
      .text-muted { color: var(--text-secondary); }
      .text-tertiary { color: var(--text-tertiary); }
      .text-sm { font-size: var(--text-sm); }
      .text-mono { font-family: var(--font-mono); }
      .text-jp { font-family: var(--font-jp); }

      /* -- Metric strip -- */
      .metric-strip {
        display: flex;
        gap: var(--space-7);
        padding: var(--space-5) 0;
        border-top: 2px solid var(--text-primary);
        margin-bottom: var(--space-7);
      }
      .metric-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .metric-value {
        font-family: var(--font-display);
        font-size: var(--text-xl);
        font-weight: 700;
        line-height: 1;
        letter-spacing: -0.02em;
        font-variant-numeric: tabular-nums;
      }
      .metric-label {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-tertiary);
        font-weight: 600;
      }

      /* -- Sections -- */
      .section {
        margin-bottom: var(--space-7);
      }
      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: var(--space-4);
      }

      .two-col {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-7);
      }
      .stack { display: grid; gap: var(--space-6); align-content: start; }

      /* -- Tables -- */
      table {
        width: 100%;
        border-collapse: collapse;
        font-variant-numeric: tabular-nums;
      }
      th {
        font-family: var(--font-body);
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
        padding: var(--space-2) var(--space-3) var(--space-2) 0;
        border-bottom: 2px solid var(--text-primary);
        text-align: left;
      }
      td {
        padding: var(--space-3) var(--space-3) var(--space-3) 0;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
        vertical-align: baseline;
      }
      tr:hover td {
        background: var(--surface-1);
      }
      tr.row-active td {
        background: var(--positive-subtle);
      }
      td code {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
      }

      /* -- Badges -- */
      .badge {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        padding: 1px var(--space-2);
        border-radius: var(--radius-sm);
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
        line-height: 1.5;
      }
      .badge::before {
        content: '';
        width: 5px;
        height: 5px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .badge.active::before, .badge.approved::before, .badge.succeeded::before, .badge.source::before, .badge.not_required::before {
        background: var(--positive);
      }
      .badge.active, .badge.approved, .badge.succeeded, .badge.source, .badge.not_required {
        background: var(--positive-subtle);
        color: var(--positive);
      }
      .badge.pending::before, .badge.running::before {
        background: var(--caution);
      }
      .badge.pending, .badge.running {
        background: var(--caution-subtle);
        color: var(--caution);
      }
      .badge.failed::before, .badge.rejected::before, .badge.superseded::before {
        background: var(--negative);
      }
      .badge.failed, .badge.rejected, .badge.superseded {
        background: var(--negative-subtle);
        color: var(--negative);
      }
      .badge.promoted::before, .badge.ai::before {
        background: var(--info);
      }
      .badge.promoted, .badge.ai {
        background: var(--info-subtle);
        color: var(--info);
      }
      .badge.inactive {
        background: var(--surface-1);
        color: var(--text-tertiary);
      }
      .badge.inactive::before {
        background: var(--text-tertiary);
      }
      .badge-row {
        display: flex;
        gap: var(--space-1);
        flex-wrap: wrap;
        align-items: center;
      }

      /* -- Forms -- */
      form {
        display: grid;
        gap: var(--space-3);
      }
      .form-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4) var(--space-5);
      }
      .inline-form {
        display: flex;
        gap: var(--space-3);
        flex-wrap: wrap;
        align-items: end;
      }
      .filter-bar {
        display: flex;
        gap: var(--space-3);
        flex-wrap: wrap;
        align-items: end;
        padding: var(--space-4) 0;
        border-bottom: 1px solid var(--border);
        margin-bottom: var(--space-5);
      }
      label {
        display: grid;
        gap: 3px;
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
      }
      input, select, textarea {
        font-family: var(--font-body);
        font-size: var(--text-sm);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        padding: var(--space-2) var(--space-3);
        background: var(--surface-2);
        color: var(--text-primary);
        transition: border-color 150ms var(--ease-out), box-shadow 150ms var(--ease-out);
      }
      input:focus, select:focus, textarea:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 2px oklch(52% 0.16 45 / 8%);
      }
      input.input-lg {
        font-size: var(--text-lg);
        font-family: var(--font-jp);
        padding: var(--space-3) var(--space-4);
      }
      textarea {
        min-height: 100px;
        resize: vertical;
        font-family: var(--font-mono);
      }
      code, pre {
        font-family: var(--font-mono);
      }
      button, .btn {
        font-family: var(--font-body);
        font-size: var(--text-sm);
        font-weight: 600;
        border-radius: var(--radius-sm);
        border: none;
        padding: var(--space-2) var(--space-4);
        cursor: pointer;
        background: var(--accent);
        color: var(--surface-2);
        transition: background 100ms var(--ease-out);
        white-space: nowrap;
        min-height: 36px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-decoration: none;
      }
      button:hover, .btn:hover {
        background: var(--accent-hover);
      }
      button:focus-visible, .btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      button.secondary {
        background: transparent;
        color: var(--text-secondary);
        border: 1px solid var(--border);
      }
      button.secondary:hover {
        background: var(--surface-1);
        border-color: var(--border-strong);
        color: var(--text-primary);
      }
      button.danger-button {
        background: transparent;
        color: var(--negative);
        border: 1px solid oklch(85% 0.04 25);
      }
      button.danger-button:hover {
        background: var(--negative-subtle);
        border-color: var(--negative);
      }
      button.sm {
        font-size: var(--text-xs);
        padding: var(--space-1) var(--space-3);
        min-height: 28px;
      }
      .btn-group {
        display: flex;
        gap: var(--space-2);
      }
      .checkbox-label {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
        font-weight: 600;
        text-transform: none;
        letter-spacing: 0;
      }
      .checkbox-label input {
        width: auto;
      }
      .alert {
        border-radius: var(--radius-md);
        padding: var(--space-4);
        border: 1px solid var(--border);
        background: var(--surface-1);
        font-size: var(--text-sm);
      }
      .alert.error {
        background: var(--negative-subtle);
        border-color: oklch(88% 0.04 25);
      }
      .alert.warning {
        background: var(--caution-subtle);
        border-color: oklch(88% 0.04 85);
      }
      .alert.success {
        background: var(--positive-subtle);
        border-color: oklch(88% 0.04 155);
      }
      .alert h3 {
        margin-bottom: var(--space-2);
        font-family: var(--font-body);
        font-size: var(--text-sm);
        font-weight: 700;
        text-transform: none;
        letter-spacing: 0;
        color: inherit;
      }
      .alert ul {
        margin: 0;
        padding-left: var(--space-5);
      }
      .alert + .alert {
        margin-top: var(--space-3);
      }
      .translation-card {
        border-top: 1px solid var(--border);
        padding: var(--space-5) 0;
        display: grid;
        gap: var(--space-4);
      }
      .translation-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
      }
      .dynamic-list {
        display: grid;
        gap: var(--space-2);
      }
      .list-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: var(--space-2);
        align-items: start;
      }
      .example-row {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        gap: var(--space-2);
        align-items: start;
      }
      .page-actions {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        flex-wrap: wrap;
        margin-top: var(--space-4);
      }
      .eyebrow {
        font-size: var(--text-xs);
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-tertiary);
      }

      /* -- Login page -- */
      .auth-page {
        min-height: 100vh;
        display: grid;
        grid-template-columns: 1fr min(480px, 100%) 1fr;
        align-content: center;
        padding: clamp(32px, 8vh, 96px) clamp(20px, 4vw, 48px);
        position: relative;
        overflow: hidden;
      }
      .auth-page > * {
        grid-column: 2;
      }
      .auth-watermark {
        position: fixed;
        right: -3vw;
        bottom: -5vh;
        font-family: var(--font-jp);
        font-size: clamp(16rem, 24vw, 32rem);
        font-weight: 700;
        line-height: 1;
        color: oklch(93% 0.015 var(--hue));
        pointer-events: none;
        user-select: none;
        z-index: 0;
      }
      .auth-content {
        position: relative;
        z-index: 1;
      }
      .auth-headword {
        font-family: var(--font-display);
        font-size: clamp(3rem, 6vw, 4.5rem);
        font-weight: 700;
        line-height: 0.9;
        letter-spacing: -0.03em;
        color: var(--text-primary);
      }
      .auth-reading {
        font-family: var(--font-jp);
        font-size: var(--text-sm);
        color: var(--text-tertiary);
        margin-top: var(--space-2);
        letter-spacing: 0.02em;
      }
      .auth-pos {
        display: inline-flex;
        gap: var(--space-2);
        margin-top: var(--space-3);
      }
      .auth-pos span {
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        padding: 1px var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .auth-divider {
        width: 48px;
        height: 2px;
        background: var(--accent);
        margin: var(--space-6) 0;
        border: none;
      }
      .auth-def-number {
        font-family: var(--font-display);
        font-size: var(--text-sm);
        font-weight: 700;
        color: var(--accent);
        margin-right: var(--space-2);
      }
      .auth-definition {
        font-size: var(--text-base);
        line-height: 1.6;
        color: var(--text-primary);
        max-width: 42ch;
      }
      .auth-context {
        font-size: var(--text-sm);
        color: var(--text-tertiary);
        margin-top: var(--space-3);
        margin-bottom: var(--space-7);
      }
      .auth-form {
        margin-top: var(--space-5);
        display: grid;
        gap: var(--space-4);
      }
      .auth-form label {
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
      }
      .auth-form input[type="password"],
      .auth-form input[type="email"] {
        font-size: var(--text-base);
        padding: var(--space-3) var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--surface-2);
        transition: border-color 150ms var(--ease-out), box-shadow 150ms var(--ease-out);
      }
      .auth-form input[type="password"] {
        font-family: var(--font-mono);
        letter-spacing: 0.1em;
      }
      .auth-form input[type="password"]:focus,
      .auth-form input[type="email"]:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 2px oklch(52% 0.16 45 / 8%);
      }
      .auth-form button[type="submit"] {
        justify-self: start;
        min-height: 44px;
        padding: var(--space-3) var(--space-7);
        font-size: var(--text-base);
      }
      .auth-footnote {
        margin-top: var(--space-6);
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        max-width: 38ch;
        line-height: 1.6;
      }
      .auth-disabled {
        margin-top: var(--space-5);
      }
      .auth-env {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin-top: var(--space-6);
        padding-top: var(--space-5);
        border-top: 1px solid var(--border);
      }
      .auth-env::before {
        content: '';
        width: 5px;
        height: 5px;
        border-radius: 50%;
      }
      .auth-env.available::before {
        background: var(--positive);
      }
      .auth-env.unavailable::before {
        background: var(--negative);
      }

      /* -- Selection bar -- */
      .selection-bar {
        display: flex;
        gap: var(--space-3);
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-3) var(--space-4);
        background: var(--surface-1);
        border-radius: var(--radius-md);
        margin-bottom: var(--space-4);
      }
      .selection-bar .inline-form {
        margin: 0;
      }
      .checkbox-inline {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
        font-weight: 600;
      }
      .checkbox-inline input {
        width: auto;
      }

      /* -- Filter chips -- */
      .filter-chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin: var(--space-4) 0;
      }
      .filter-chip {
        display: inline-flex;
        align-items: center;
        padding: var(--space-1) var(--space-3);
        border: 1px solid var(--border);
        border-radius: 999px;
        text-decoration: none;
        color: var(--text-secondary);
        background: transparent;
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        transition: border-color 100ms var(--ease-out), color 100ms var(--ease-out), background 100ms var(--ease-out);
      }
      .filter-chip:hover {
        text-decoration: none;
        color: var(--text-primary);
        border-color: var(--border-strong);
      }
      .filter-chip[aria-current="page"] {
        color: var(--accent);
        border-color: var(--accent);
        background: var(--accent-subtle);
      }

      /* -- Summary strip (replaces card grid) -- */
      .summary-strip {
        display: flex;
        gap: var(--space-6);
        padding: var(--space-4) 0;
        border-top: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
        margin-bottom: var(--space-5);
        flex-wrap: wrap;
      }
      .summary-strip-item {
        display: grid;
        gap: 2px;
      }
      .summary-strip-item h3 {
        margin-bottom: 0;
      }

      /* -- Lists & items -- */
      .item-list {
        display: grid;
        gap: 0;
      }
      .item {
        padding: var(--space-5) 0;
        border-bottom: 1px solid var(--border);
      }
      .item:first-child {
        border-top: 1px solid var(--border);
      }
      .item-header {
        display: flex;
        justify-content: space-between;
        align-items: start;
        gap: var(--space-3);
        margin-bottom: var(--space-2);
        flex-wrap: wrap;
      }
      .item-word {
        font-family: var(--font-jp);
        font-size: var(--text-lg);
        font-weight: 700;
      }
      .item-lang {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-left: var(--space-2);
        vertical-align: middle;
      }
      .item-meta {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin-top: var(--space-3);
      }
      .item ul, .item ol {
        margin: var(--space-2) 0;
        padding-left: var(--space-5);
      }
      .item li {
        font-size: var(--text-sm);
        margin-bottom: var(--space-1);
      }
      .item table {
        margin-top: var(--space-3);
      }
      .unit-selection {
        margin-right: var(--space-2);
      }
      .unit-selection input {
        width: auto;
      }
      .diff-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-3);
        margin-top: var(--space-4);
      }
      .diff-block {
        padding: var(--space-3) 0;
      }
      .diff-block h4 {
        font-family: var(--font-body);
        font-size: var(--text-xs);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
        margin-bottom: var(--space-2);
        padding-bottom: var(--space-2);
        border-bottom: 1px solid var(--border);
      }
      .diff-block ul {
        margin: 0;
        padding-left: var(--space-4);
      }
      .diff-block li {
        font-size: var(--text-xs);
        line-height: 1.5;
      }

      /* -- Stat lists -- */
      .stat-list {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: var(--space-1) var(--space-4);
        font-size: var(--text-sm);
      }
      .stat-list dt {
        color: var(--text-secondary);
      }
      .stat-list dd {
        font-family: var(--font-mono);
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }

      /* -- Definition list (account page) -- */
      .definition-list {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--space-2) var(--space-5);
        font-size: var(--text-sm);
      }
      .definition-list dt {
        color: var(--text-tertiary);
        font-weight: 600;
        text-transform: uppercase;
        font-size: var(--text-xs);
        letter-spacing: 0.04em;
        align-self: center;
      }
      .definition-list dd {
        color: var(--text-primary);
      }

      /* -- Quick links -- */
      .quick-links {
        display: grid;
        gap: 0;
      }
      .quick-links a {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        text-decoration: none;
        border-bottom: 1px solid var(--border);
        transition: color 100ms var(--ease-out);
      }
      .quick-links a:first-child {
        border-top: 1px solid var(--border);
      }
      .quick-links a:hover {
        color: var(--accent);
        text-decoration: none;
      }
      .quick-links .link-desc {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        text-align: right;
      }

      /* -- JSON blocks / details -- */
      .json-details {
        margin-top: var(--space-3);
      }
      .json-details summary {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        cursor: pointer;
        padding: var(--space-1) 0;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .json-details summary:hover {
        color: var(--accent);
      }
      pre {
        margin: var(--space-2) 0 0;
        overflow: auto;
        background: var(--surface-code);
        color: var(--text-on-code);
        padding: var(--space-4);
        border-radius: var(--radius-md);
        font-size: var(--text-xs);
        line-height: 1.6;
      }

      /* -- Entry inspector -- */
      .entry-word {
        font-family: var(--font-jp);
        font-size: var(--text-2xl);
        font-weight: 700;
        line-height: 1.1;
      }
      .entry-reading {
        font-family: var(--font-jp);
        font-size: var(--text-lg);
        color: var(--text-secondary);
        margin-left: var(--space-3);
      }
      .entry-detail {
        font-size: var(--text-sm);
        color: var(--text-tertiary);
      }
      .entry-section {
        padding: var(--space-5) 0;
        border-bottom: 1px solid var(--border);
      }
      .entry-section:last-child {
        border-bottom: none;
      }
      .entry-section h3 {
        margin-bottom: var(--space-3);
      }
      .entry-definitions {
        padding-left: var(--space-5);
        margin: 0;
      }
      .entry-definitions li {
        margin-bottom: var(--space-1);
        font-size: var(--text-base);
      }
      .entry-examples {
        display: grid;
        gap: var(--space-2);
        margin-top: var(--space-2);
      }
      .entry-example-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
        padding: var(--space-2) 0;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .entry-example-jp {
        font-family: var(--font-jp);
      }

      /* -- Panels -- */
      .panel {
        border-top: 2px solid var(--border-strong);
        padding: var(--space-5) 0;
      }

      /* -- Empty states -- */
      .empty {
        padding: var(--space-5) 0;
        color: var(--text-tertiary);
        font-size: var(--text-sm);
        text-align: left;
      }
      .empty a {
        color: var(--accent);
      }

      /* -- Result display -- */
      .result {
        margin-top: var(--space-2);
        display: none;
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        padding: var(--space-3);
        background: var(--surface-code);
        color: var(--text-on-code);
        border-radius: var(--radius-sm);
        overflow: auto;
        max-height: 300px;
      }
      .result.visible { display: block; }

      /* -- Loading spinner -- */
      form[aria-busy="true"] button[type="submit"] {
        opacity: 0.6;
        pointer-events: none;
      }
      form[aria-busy="true"] button[type="submit"]::after {
        content: '';
        display: inline-block;
        width: 12px;
        height: 12px;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: spin 600ms linear infinite;
        margin-left: var(--space-2);
        vertical-align: middle;
      }
      @keyframes spin { to { transform: rotate(360deg); } }

      /* -- Responsive -- */
      @media (max-width: 768px) {
        .shell {
          grid-template-columns: 1fr;
        }
        .sidebar {
          position: fixed;
          left: -260px;
          width: 260px;
          z-index: 99;
          transition: left 200ms var(--ease-out);
        }
        .sidebar.open {
          left: 0;
        }
        .mobile-toggle {
          display: block;
        }
        .content {
          padding: var(--space-6) var(--space-4) var(--space-8);
        }
        .content-header {
          flex-direction: column;
          align-items: stretch;
        }
        .two-col {
          grid-template-columns: 1fr;
        }
        .form-grid {
          grid-template-columns: 1fr;
        }
        .metric-strip {
          flex-direction: column;
          gap: var(--space-4);
        }
        .summary-strip {
          flex-direction: column;
          gap: var(--space-4);
        }
        .entry-example-row {
          grid-template-columns: 1fr;
        }
        .example-row,
        .list-row {
          grid-template-columns: 1fr;
        }
        .diff-grid {
          grid-template-columns: 1fr 1fr;
        }
        .auth-page {
          grid-template-columns: 1fr;
          padding: var(--space-6) var(--space-4);
        }
        .auth-page > * {
          grid-column: 1;
        }
        .auth-headword {
          font-size: clamp(2.5rem, 10vw, 3.5rem);
        }
        .auth-watermark {
          font-size: clamp(10rem, 36vw, 16rem);
          right: -8vw;
          bottom: -3vh;
        }
      }
    </style>
  </head>
  <body class="${standalone ? 'standalone-body' : ''}">
    ${standalone
      ? body
      : `
    <button class="mobile-toggle" onclick="document.querySelector('.sidebar').classList.toggle('open')">Menu</button>
    <div class="shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          Yori
          <span>Dictionary Admin</span>
        </div>
        <nav>
          ${navHtml}
        </nav>
      </aside>
      <main class="content">
        ${utilityHtml}
        ${body}
      </main>
    </div>`}
    ${includeScripts ? `<script>
      async function submitJsonForm(event) {
        if (event.defaultPrevented) return;
        event.preventDefault();
        const form = event.currentTarget;
        if (form.dataset.newWordForm === 'true') {
          return submitNewWordForm(form);
        }
        const result = form.querySelector('[data-result]');
        const submitter = event.submitter;
        if (submitter && submitter.dataset.confirm) {
          if (!window.confirm(submitter.dataset.confirm)) return;
        }
        form.setAttribute('aria-busy', 'true');
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
        } finally {
          form.removeAttribute('aria-busy');
        }
      }

      function syncSelectedUnitIds(form) {
        const container = form.querySelector('[data-selected-unit-ids]');
        if (!container) return 0;
        const values = Array.from(document.querySelectorAll('[data-review-unit-checkbox]:checked'))
          .map((input) => input.value);

        container.replaceChildren(...values.map((value) => {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = 'unitIds';
          input.value = value;
          return input;
        }));

        return values.length;
      }

      function toggleAllReviewUnits(checked) {
        for (const input of document.querySelectorAll('[data-review-unit-checkbox]')) {
          input.checked = checked;
        }
      }

      function createButton(label, className, handler) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        if (className) button.className = className;
        button.addEventListener('click', handler);
        return button;
      }

      function escapeHtmlClient(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function updateWordIdPreview(form) {
        const word = form.querySelector('[name="word"]').value.trim();
        const reading = form.querySelector('[name="reading"]').value.trim();
        const preview = form.querySelector('[data-word-id-preview]');
        if (!preview) return;
        preview.textContent = word && reading ? word + ':' + reading : 'waiting for word + reading';
      }

      function addDefinitionRow(container, value = '') {
        const row = document.createElement('div');
        row.className = 'list-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        input.placeholder = 'Definition';
        input.dataset.definitionInput = 'true';
        const remove = createButton('Remove', 'secondary sm', () => row.remove());
        row.append(input, remove);
        container.append(row);
      }

      function addExampleRow(container, japanese = '', translation = '') {
        const row = document.createElement('div');
        row.className = 'example-row';
        const japaneseInput = document.createElement('input');
        japaneseInput.type = 'text';
        japaneseInput.value = japanese;
        japaneseInput.placeholder = 'Japanese example';
        japaneseInput.dataset.exampleJapanese = 'true';
        const translationInput = document.createElement('input');
        translationInput.type = 'text';
        translationInput.value = translation;
        translationInput.placeholder = 'Translation';
        translationInput.dataset.exampleTranslation = 'true';
        const remove = createButton('Remove', 'secondary sm', () => row.remove());
        row.append(japaneseInput, translationInput, remove);
        container.append(row);
      }

      function addTranslationCard(form, lang = 'en') {
        const container = form.querySelector('[data-translation-list]');
        if (!container) return;
        const card = document.createElement('section');
        card.className = 'translation-card';
        card.dataset.translationCard = 'true';
        card.innerHTML = [
          '<div class="translation-card-header">',
          '  <label>Language',
          '    <select data-translation-lang>',
          '      <option value="en">en</option>',
          '      <option value="de">de</option>',
          '      <option value="ko">ko</option>',
          '      <option value="zh-cn">zh-cn</option>',
          '      <option value="zh-tw">zh-tw</option>',
          '    </select>',
          '  </label>',
          '</div>',
          '<div>',
          '  <div class="section-header">',
          '    <h3>Definitions</h3>',
          '  </div>',
          '  <div class="dynamic-list" data-definition-list></div>',
          '  <button type="button" class="secondary sm" data-add-definition>Add definition</button>',
          '</div>',
          '<div>',
          '  <div class="section-header">',
          '    <h3>Examples</h3>',
          '  </div>',
          '  <div class="dynamic-list" data-example-list></div>',
          '  <button type="button" class="secondary sm" data-add-example>Add example</button>',
          '</div>',
        ].join('');
        card.querySelector('[data-translation-lang]').value = lang;
        card.querySelector('[data-add-definition]').addEventListener('click', () => {
          addDefinitionRow(card.querySelector('[data-definition-list]'));
        });
        card.querySelector('[data-add-example]').addEventListener('click', () => {
          addExampleRow(card.querySelector('[data-example-list]'));
        });
        const removeButton = createButton('Remove language', 'secondary sm', () => card.remove());
        card.querySelector('.translation-card-header').append(removeButton);
        container.append(card);
        addDefinitionRow(card.querySelector('[data-definition-list]'));
      }

      function collectNewWordPayload(form) {
        const partOfSpeech = form.querySelector('[name="partOfSpeech"]').value
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);

        const translations = Array.from(form.querySelectorAll('[data-translation-card="true"]')).map((card) => ({
          lang: card.querySelector('[data-translation-lang]').value,
          definitions: Array.from(card.querySelectorAll('[data-definition-input="true"]'))
            .map((input) => input.value.trim())
            .filter(Boolean),
          examples: Array.from(card.querySelectorAll('.example-row')).map((row) => ({
            japanese: row.querySelector('[data-example-japanese]').value.trim(),
            translation: row.querySelector('[data-example-translation]').value.trim(),
          })).filter((item) => item.japanese || item.translation),
        }));

        return {
          word: form.querySelector('[name="word"]').value,
          reading: form.querySelector('[name="reading"]').value,
          partOfSpeech,
          common: form.querySelector('[name="common"]').checked,
          jlpt: form.querySelector('[name="jlpt"]').value ? Number(form.querySelector('[name="jlpt"]').value) : null,
          translations,
        };
      }

      function renderAlert(container, title, items, kind) {
        if (!container || !items || items.length === 0) {
          if (container) container.innerHTML = '';
          return;
        }
        container.innerHTML = [
          '<div class="alert ' + escapeHtmlClient(kind) + '">',
          '  <h3>' + escapeHtmlClient(title) + '</h3>',
          '  <ul>' + items.map((item) => '<li>' + escapeHtmlClient(item) + '</li>').join('') + '</ul>',
          '</div>',
        ].join('');
      }

      function renderFieldErrors(container, fieldErrors) {
        if (!container) return;
        const items = [];
        for (const [field, messages] of Object.entries(fieldErrors || {})) {
          for (const message of messages) items.push(field + ': ' + message);
        }
        renderAlert(container, 'Validation errors', items, 'error');
      }

      function renderNewWordSuccess(form, response) {
        const success = form.querySelector('[data-new-word-success]');
        const errors = form.querySelector('[data-new-word-errors]');
        const warnings = form.querySelector('[data-new-word-warnings]');
        renderFieldErrors(errors, {});
        renderAlert(warnings, 'Warnings', response.warnings || [], 'warning');
        if (!success) return;
        success.innerHTML = [
          '<div class="alert success">',
          '  <h3>New word saved to snapshot</h3>',
          '  <ul>',
          '    <li>Word ID: <code>' + escapeHtmlClient(response.wordId) + '</code></li>',
          '    <li>Active release: <code>' + escapeHtmlClient(response.releaseVersion) + '</code></li>',
          '    <li>This word is not live yet. Build a new release to make it searchable, then open Entry Inspector to verify it.</li>',
          '  </ul>',
          '  <div class="page-actions">',
          '    <a href="' + response.nextActions.releasesUrl + '">Open releases</a>',
          '    <button type="button" data-build-release>Build & activate new release</button>',
          '  </div>',
          '</div>',
          '<div class="alert">',
          '  <h3>Snapshot files</h3>',
          '  <ul>' + (response.snapshotFiles || []).map((file) => '<li><code>' + escapeHtmlClient(file) + '</code></li>').join('') + '</ul>',
          '</div>',
        ].join('');
        const buildButton = success.querySelector('[data-build-release]');
        if (buildButton) {
          buildButton.addEventListener('click', async () => {
            buildButton.disabled = true;
            const res = await fetch(response.nextActions.buildReleaseUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ activate: true, createdWordId: response.wordId }),
            });
            const data = await res.json();
            if (res.ok) {
              success.innerHTML = [
                '<div class="alert success">',
                '  <h3>Release built and activated</h3>',
                '  <ul>',
                '    <li>Release: <code>' + escapeHtmlClient(data.version) + '</code></li>',
                '    <li>New word: <code>' + escapeHtmlClient(data.createdWordId || response.wordId) + '</code></li>',
                '  </ul>',
                '  <div class="page-actions">',
                '    <a href="' + response.nextActions.entryInspectorUrl + '">Open entry inspector</a>',
                '    <a href="' + response.nextActions.releasesUrl + '">Open releases</a>',
                '  </div>',
                '</div>',
              ].join('');
            } else {
              buildButton.disabled = false;
              renderFieldErrors(errors, { release: [data.error || 'Failed to build release.'] });
            }
          });
        }
      }

      async function submitNewWordForm(form) {
        const errors = form.querySelector('[data-new-word-errors]');
        const warnings = form.querySelector('[data-new-word-warnings]');
        const success = form.querySelector('[data-new-word-success]');
        if (errors) errors.innerHTML = '';
        if (warnings) warnings.innerHTML = '';
        if (success) success.innerHTML = '';
        form.setAttribute('aria-busy', 'true');
        try {
          const res = await fetch(form.action, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(collectNewWordPayload(form)),
          });
          const data = await res.json();
          if (!res.ok) {
            renderFieldErrors(errors, data.fieldErrors || {});
            renderAlert(warnings, 'Warnings', data.warnings || [], 'warning');
            if (data.conflictWordId && success) {
              success.innerHTML = [
                '<div class="alert">',
                '  <h3>Existing word found</h3>',
                '  <p><code>' + escapeHtmlClient(data.conflictWordId) + '</code> already exists.</p>',
                '</div>',
              ].join('');
            }
            return;
          }
          renderNewWordSuccess(form, data);
        } catch (error) {
          renderFieldErrors(errors, { request: [String(error)] });
        } finally {
          form.removeAttribute('aria-busy');
        }
      }

      for (const form of document.querySelectorAll('form[data-json-form="true"]')) {
        if (form.dataset.reviewBulkForm === 'true') {
          form.addEventListener('submit', (event) => {
            const selectedCount = syncSelectedUnitIds(form);
            if (selectedCount === 0) {
              event.preventDefault();
              const result = form.querySelector('[data-result]');
              if (result) {
                result.textContent = 'Select at least one review unit.';
                result.classList.add('visible');
              }
              return;
            }
          });
        }
        form.addEventListener('submit', submitJsonForm);
      }
      for (const form of document.querySelectorAll('form[data-new-word-form="true"]')) {
        form.addEventListener('submit', submitJsonForm);
        const word = form.querySelector('[name="word"]');
        const reading = form.querySelector('[name="reading"]');
        if (word) word.addEventListener('input', () => updateWordIdPreview(form));
        if (reading) reading.addEventListener('input', () => updateWordIdPreview(form));
        form.querySelector('[data-add-translation]').addEventListener('click', () => addTranslationCard(form));
        addTranslationCard(form, 'en');
        updateWordIdPreview(form);
      }
      for (const button of document.querySelectorAll('[data-review-select-all]')) {
        button.addEventListener('click', () => toggleAllReviewUnits(true));
      }
      for (const button of document.querySelectorAll('[data-review-clear-all]')) {
        button.addEventListener('click', () => toggleAllReviewUnits(false));
      }
    </script>` : ''}
  </body>
</html>`
}

function renderBadge(value: string): string {
  return `<span class="badge ${escapeHtml(value)}">${escapeHtml(value)}</span>`
}

function renderBatchTable(batches: UpdateBatchRecord[]): string {
  if (batches.length === 0) return '<div class="empty">No batches recorded yet. Batches are created when you run source updates or Gemini imports from the <a href="/admin/jobs">Jobs</a> page.</div>'
  return `<table>
    <thead><tr><th>ID</th><th>Kind</th><th>Status</th><th>Actor</th><th>Created</th><th>Notes</th></tr></thead>
    <tbody>
      ${batches.map((batch) => `
        <tr>
          <td><a href="/admin/jobs?batchId=${batch.id}">${batch.id}</a></td>
          <td>${escapeHtml(batch.kind)}</td>
          <td>${renderBadge(batch.status)}</td>
          <td>${escapeHtml(batch.actor ?? 'system')}</td>
          <td class="text-tertiary">${formatTimestamp(batch.createdAt)}</td>
          <td class="text-sm">${escapeHtml(batch.notes ?? '')}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>`
}

function renderReleaseTable(releases: ReleaseListItem[]): string {
  if (releases.length === 0) return '<div class="empty">No releases found. Build your first release from the form below.</div>'
  return `<table>
    <thead><tr><th>Version</th><th>Built</th><th>Schema</th><th>Fingerprint</th><th>Promoted From</th><th>State</th><th></th></tr></thead>
    <tbody>
      ${releases.map((release) => `
        <tr class="${release.isActive ? 'row-active' : ''}">
          <td><strong>${escapeHtml(release.version)}</strong></td>
          <td class="text-tertiary">${formatTimestamp(release.builtAt)}</td>
          <td>${escapeHtml(release.schemaVersion)}</td>
          <td><code title="${escapeHtml(release.baseSourceFingerprint)}">${escapeHtml(release.baseSourceFingerprint.slice(0, 12))}&hellip;</code></td>
          <td>${escapeHtml(release.promotedFromUpdateSequence ?? 'n/a')}</td>
          <td>${release.isActive ? renderBadge('active') : renderBadge('inactive')}</td>
          <td>${release.isActive ? '' : `
            <form action="/admin/api/releases/${escapeHtml(release.version)}/activate" method="POST" data-json-form="true" data-reload="true" style="display:inline">
              <button type="submit" class="secondary sm">Activate</button>
              <div class="result" data-result></div>
            </form>
          `}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>`
}

function renderTranslationCards(items: ListedTranslationUpdate[]): string {
  if (items.length === 0) return '<div class="empty">No translation updates match this view. Translations are created during source updates or Gemini imports.</div>'
  return `<div class="item-list">
    ${items.map((item) => `
      <div class="item">
        <div class="item-header">
          <div>
            <span class="item-word">${escapeHtml(item.wordId)}</span>
            <span class="item-lang">${escapeHtml(item.lang)}</span>
          </div>
          <div class="badge-row">
            ${renderBadge(item.sourceType)}
            ${renderBadge(item.status)}
            ${renderBadge(item.reviewStatus)}
          </div>
        </div>
        <ol class="entry-definitions">
          ${item.definitions.map((def) => `<li>${escapeHtml(def)}</li>`).join('')}
        </ol>
        <div class="item-meta">
          Sources: ${escapeHtml(item.sources.join(', '))} &middot; Batch ${item.batchId} &middot; ${formatTimestamp(item.createdAt)}
        </div>
      </div>
    `).join('')}
  </div>`
}

function renderExampleCards(items: ListedExampleUpdateSet[]): string {
  if (items.length === 0) return '<div class="empty">No example update sets match this view. Examples are created during Gemini imports.</div>'
  return `<div class="item-list">
    ${items.map((item) => `
      <div class="item">
        <div class="item-header">
          <div>
            <span class="item-word">${escapeHtml(item.wordId)}</span>
            <span class="item-lang">${escapeHtml(item.lang)}</span>
          </div>
          <div class="badge-row">
            ${renderBadge(item.sourceType)}
            ${renderBadge(item.status)}
            ${renderBadge(item.reviewStatus)}
          </div>
        </div>
        <div class="entry-examples">
          ${item.examples.map((ex) => `
            <div class="entry-example-row">
              <span class="entry-example-jp">${escapeHtml(ex.japanese)}</span>
              <span>${escapeHtml(ex.translation)}</span>
            </div>
          `).join('')}
        </div>
        <div class="item-meta">
          Batch ${item.batchId} &middot; ${formatTimestamp(item.createdAt)}
        </div>
      </div>
    `).join('')}
  </div>`
}

function renderInlineDefinitionList(value: ReviewUnitReleaseValue | null): string {
  if (!value || value.definitions.length === 0) return '<div class="text-muted text-sm">No definitions</div>'
  return `<ul>${value.definitions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
}

function renderInlineExampleList(value: ReviewUnitReleaseValue | null): string {
  if (!value || value.examples.length === 0) return '<div class="text-muted text-sm">No examples</div>'
  return `<ul>${value.examples.map((item) => `<li>${escapeHtml(item.japanese)} &middot; ${escapeHtml(item.translation)}</li>`).join('')}</ul>`
}

function renderReviewUnit(unit: ReviewUnit): string {
  const inspectorLabel = unit.word?.word ?? unit.word?.reading ?? unit.wordId.split(':')[0]
  return `<div class="item">
    <div class="item-header">
      <div style="display:flex; align-items:center; gap: var(--space-2); flex-wrap:wrap">
        <label class="unit-selection"><input type="checkbox" data-review-unit-checkbox value="${escapeHtml(unit.unitId)}" /></label>
        <span class="item-word">${escapeHtml(unit.word?.word ?? unit.wordId)}</span>
        <span class="item-lang">${escapeHtml(unit.lang)}</span>
      </div>
      <div class="badge-row">
        ${renderBadge(`risk-${unit.riskLevel}`)}
        ${renderBadge(`batch-${unit.batchId}`)}
        ${unit.flags.hasSourceConflict ? renderBadge('source-conflict') : ''}
        ${unit.flags.isTranslationOnly ? renderBadge('translation-only') : ''}
        ${unit.flags.isExamplesOnly ? renderBadge('examples-only') : ''}
      </div>
    </div>
    <div class="item-meta">
      Word ID ${escapeHtml(unit.wordId)} &middot; Batch ${unit.batchId} &middot; ${escapeHtml(unit.batch?.actor ?? 'system')}
    </div>
    <div class="diff-grid">
      <div class="diff-block">
        <h4>Release</h4>
        ${renderInlineDefinitionList(unit.release)}
        ${renderInlineExampleList(unit.release)}
      </div>
      <div class="diff-block">
        <h4>Source Override</h4>
        ${renderInlineDefinitionList(unit.sourceUpdate.translation ? {
          definitions: unit.sourceUpdate.translation.definitions,
          sources: unit.sourceUpdate.translation.sources,
          examples: unit.sourceUpdate.examples?.examples.map((example) => ({
            japanese: example.japanese,
            translation: example.translation,
            source: example.source,
          })) ?? [],
        } : unit.sourceUpdate.examples ? {
          definitions: [],
          sources: [],
          examples: unit.sourceUpdate.examples.examples.map((example) => ({
            japanese: example.japanese,
            translation: example.translation,
            source: example.source,
          })),
        } : null)}
        ${renderInlineExampleList(unit.sourceUpdate.translation ? {
          definitions: unit.sourceUpdate.translation.definitions,
          sources: unit.sourceUpdate.translation.sources,
          examples: unit.sourceUpdate.examples?.examples.map((example) => ({
            japanese: example.japanese,
            translation: example.translation,
            source: example.source,
          })) ?? [],
        } : unit.sourceUpdate.examples ? {
          definitions: [],
          sources: [],
          examples: unit.sourceUpdate.examples.examples.map((example) => ({
            japanese: example.japanese,
            translation: example.translation,
            source: example.source,
          })),
        } : null)}
      </div>
      <div class="diff-block">
        <h4>AI Candidate</h4>
        ${renderInlineDefinitionList(unit.translation ? {
          definitions: unit.translation.definitions,
          sources: unit.translation.sources,
          examples: unit.exampleSet?.examples.map((example) => ({
            japanese: example.japanese,
            translation: example.translation,
            source: example.source,
          })) ?? [],
        } : unit.exampleSet ? {
          definitions: [],
          sources: [],
          examples: unit.exampleSet.examples.map((example) => ({
            japanese: example.japanese,
            translation: example.translation,
            source: example.source,
          })),
        } : null)}
        ${renderInlineExampleList(unit.translation ? {
          definitions: unit.translation.definitions,
          sources: unit.translation.sources,
          examples: unit.exampleSet?.examples.map((example) => ({
            japanese: example.japanese,
            translation: example.translation,
            source: example.source,
          })) ?? [],
        } : unit.exampleSet ? {
          definitions: [],
          sources: [],
          examples: unit.exampleSet.examples.map((example) => ({
            japanese: example.japanese,
            translation: example.translation,
            source: example.source,
          })),
        } : null)}
      </div>
      <div class="diff-block">
        <h4>Effective If Approved</h4>
        ${renderInlineDefinitionList(unit.effectivePreview)}
        ${renderInlineExampleList(unit.effectivePreview)}
      </div>
    </div>
    <div class="page-actions">
      <form action="/admin/api/review/units/approve" method="POST" data-json-form="true" data-reload="true" class="inline-form">
        <input type="hidden" name="unitIds" value="${escapeHtml(unit.unitId)}" />
        ${unit.flags.hasSourceConflict ? `
          <label class="checkbox-inline">
            <input type="checkbox" name="overrideSourceConflict" value="true" />
            Override source conflict
          </label>
        ` : ''}
        <button type="submit">Approve</button>
        <button type="submit" class="secondary" formaction="/admin/api/review/units/reject" data-confirm="Reject this review unit?">Reject</button>
        <div class="result" data-result></div>
      </form>
      <a href="/admin/entry?word=${encodeURIComponent(inspectorLabel)}&lang=${encodeURIComponent(unit.lang)}">Open Inspector</a>
    </div>
  </div>`
}

export function renderAdminLoginPage(options: {
  disabled?: boolean
  error?: string | null
  next?: string | null
} = {}): string {
  const disabled = options.disabled ?? false
  const next = escapeHtml(options.next ?? '/admin')
  const errorHtml = options.error
    ? `<div class="alert error"><h3>Access denied</h3><p>${escapeHtml(options.error)}</p></div>`
    : ''

  const formSection = disabled
    ? `
      <div class="auth-disabled">
        <div class="alert warning">
          <h3>Admin UI is offline</h3>
          <p>Set <code>JWT_SECRET</code> in the runtime environment and create an admin user via <code>bun run scripts/admin/create-user.ts</code>, then redeploy.</p>
        </div>
      </div>
      <p class="auth-footnote">The public API continues to serve lookups. Only the admin console requires authentication.</p>
    `
    : `
      ${errorHtml}
      <form action="/admin/login" method="POST" class="auth-form">
        <input type="hidden" name="next" value="${next}" />
        <label>Email
          <input type="email" name="email" autocomplete="username" autofocus placeholder="admin@example.com" />
        </label>
        <label>Password
          <input type="password" name="password" autocomplete="current-password" placeholder="Your admin password" />
        </label>
        <button type="submit">Sign in</button>
      </form>
      <p class="auth-footnote">Sessions renew silently for 30 days. Sign out to revoke.</p>
    `

  return renderPage('Admin Login', `
    <div class="auth-page">
      <div class="auth-watermark">辞</div>
      <div class="auth-content">
        <div class="auth-headword">Yori</div>
        <div class="auth-reading">よりじてん · dictionary admin</div>
        <div class="auth-pos">
          <span>noun</span>
          <span>internal tool</span>
        </div>

        <hr class="auth-divider" />

        <div class="auth-definition">
          <span class="auth-def-number">1.</span>
          Operational interface for managing releases, reviewing AI translations, and maintaining multilingual dictionary data.
        </div>
        <div class="auth-context">Release control, review queues, data quality.</div>

        ${formSection}

        <div class="auth-env ${disabled ? 'unavailable' : 'available'}">
          ${disabled ? 'JWT secret not configured' : 'Ready to authenticate'}
        </div>
      </div>
    </div>
  `, {
    includeScripts: false,
    standalone: true,
    utilityHtml: '',
  })
}

export function renderAdminSetupPage(options: {
  error?: string | null
} = {}): string {
  const errorHtml = options.error
    ? `<div class="alert error"><h3>Error</h3><p>${escapeHtml(options.error)}</p></div>`
    : ''

  return renderPage('Setup — Yori Admin', `
    <div class="auth-page">
      <div class="auth-watermark">辞</div>
      <div class="auth-content">
        <div class="auth-headword">Yori</div>
        <div class="auth-reading">よりじてん · first-time setup</div>
        <div class="auth-pos">
          <span>noun</span>
          <span>internal tool</span>
        </div>

        <hr class="auth-divider" />

        <div class="auth-definition">
          <span class="auth-def-number">1.</span>
          Create the first admin account to get started.
        </div>

        ${errorHtml}
        <form action="/admin/setup" method="POST" class="auth-form">
          <label>Email
            <input type="email" name="email" autocomplete="username" autofocus placeholder="admin@example.com" required />
          </label>
          <label>Password
            <input type="password" name="password" autocomplete="new-password" placeholder="12 characters minimum" minlength="12" required />
          </label>
          <label>Confirm password
            <input type="password" name="confirmPassword" autocomplete="new-password" placeholder="Repeat password" minlength="12" required />
          </label>
          <button type="submit">Create account</button>
        </form>
        <p class="auth-footnote">This page is available once. After the first account is created, use the login screen.</p>
      </div>
    </div>
  `, {
    includeScripts: false,
    standalone: true,
    utilityHtml: '',
  })
}

function renderReviewUnitList(items: ReviewUnit[]): string {
  if (items.length === 0) return '<div class="empty">No pending review units match this view.</div>'
  return `<div class="item-list">${items.map(renderReviewUnit).join('')}</div>`
}

function renderReviewSummaryCards(summary: AdminReviewQueueResponseV2['summary'] | AdminReviewBatchSummaryResponse): string {
  const splitHtml = 'translationOnlyCount' in summary
    ? `<div class="summary-strip-item">
        <h3>Split</h3>
        <dl class="stat-list"><dt>Translation only</dt><dd>${escapeHtml(summary.translationOnlyCount)}</dd><dt>Examples only</dt><dd>${escapeHtml(summary.examplesOnlyCount)}</dd></dl>
      </div>`
    : ''

  return `<div class="summary-strip">
    <div class="summary-strip-item">
      <h3>Pending</h3>
      <span class="metric-value">${escapeHtml(summary.pendingUnits)}</span>
    </div>
    <div class="summary-strip-item">
      <h3>Conflicts</h3>
      <span class="metric-value">${escapeHtml(summary.sourceConflictCount)}</span>
    </div>
    <div class="summary-strip-item">
      <h3>By Language</h3>
      ${renderDefinitionList(summary.byLanguage)}
    </div>
    <div class="summary-strip-item">
      <h3>By Risk</h3>
      ${renderDefinitionList(summary.byRisk as Record<string, number>)}
    </div>
    ${splitHtml}
  </div>`
}

function renderRecentReviewBatches(items: ReviewQueueSummaryRecentBatch[]): string {
  if (items.length === 0) return '<div class="empty">No pending AI batches right now.</div>'
  return `<table>
    <thead><tr><th>Batch</th><th>Actor</th><th>Pending Units</th><th>Source Conflicts</th><th>Languages</th><th>Open</th></tr></thead>
    <tbody>
      ${items.map((item) => `
        <tr>
          <td>${escapeHtml(item.batchId)}</td>
          <td>${escapeHtml(item.batch?.actor ?? 'system')}</td>
          <td>${escapeHtml(item.pendingUnits)}</td>
          <td>${escapeHtml(item.sourceConflictCount)}</td>
          <td>${escapeHtml(Object.entries(item.byLanguage).map(([lang, count]) => `${lang}:${count}`).join(', '))}</td>
          <td><a href="/admin/review/batch/${item.batchId}">Open batch</a></td>
        </tr>
      `).join('')}
    </tbody>
  </table>`
}

function renderReviewFilterChips(basePath: string, current: {
  risk: ReviewRiskLevel | null
  shape: ReviewUnitShape | null
  hasSourceConflict: boolean | null
}): string {
  const chips = [
    { label: 'All', href: basePath, active: current.risk === null && current.shape === null && current.hasSourceConflict === null },
    { label: 'Low risk', href: `${basePath}?risk=low`, active: current.risk === 'low' && current.shape === null && current.hasSourceConflict === null },
    { label: 'Medium risk', href: `${basePath}?risk=medium`, active: current.risk === 'medium' && current.shape === null && current.hasSourceConflict === null },
    { label: 'High risk', href: `${basePath}?risk=high`, active: current.risk === 'high' && current.shape === null && current.hasSourceConflict === null },
    { label: 'Source conflict', href: `${basePath}?hasSourceConflict=true`, active: current.hasSourceConflict === true },
    { label: 'Translation only', href: `${basePath}?shape=translation-only`, active: current.shape === 'translation-only' },
    { label: 'Examples only', href: `${basePath}?shape=examples-only`, active: current.shape === 'examples-only' },
  ]
  return `<div class="filter-chips">
    ${chips.map((chip) => `<a class="filter-chip" href="${chip.href}" ${chip.active ? 'aria-current="page"' : ''}>${escapeHtml(chip.label)}</a>`).join('')}
  </div>`
}

function buildReviewPageLink(basePath: string, params: Record<string, string | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const serialized = search.toString()
  return serialized ? `${basePath}?${serialized}` : basePath
}

export function renderDashboardPage(data: AdminSummaryResponse): string {
  const pendingCount = (data.reviewCounts['translation:pending'] ?? 0) + (data.reviewCounts['example:pending'] ?? 0)
  return renderPage('Dashboard', `
    <div class="page-header">
      <h1>Dashboard</h1>
    </div>

    <div class="metric-strip">
      <div class="metric-item">
        <span class="metric-label">Active Release</span>
        <span class="metric-value">${escapeHtml(data.activeReleaseVersion)}</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">Pending Review</span>
        <span class="metric-value">${escapeHtml(pendingCount)}</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">Orphaned</span>
        <span class="metric-value">${escapeHtml(data.orphanedWordIdsCount)}</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">Reviewed AI</span>
        <span class="metric-value">${escapeHtml(data.activeReviewedAiCount)}</span>
      </div>
    </div>

    <div class="section">
      <h2>Quick Actions</h2>
      <div class="quick-links">
        <a href="/admin/review">
          <span>AI Review Queue</span>
          <span class="link-desc">${pendingCount} pending</span>
        </a>
        <a href="/admin/entry">
          <span>Entry Inspector</span>
          <span class="link-desc">Look up any word</span>
        </a>
        <a href="/admin/new-word">
          <span>New Word</span>
          <span class="link-desc">Add to snapshot</span>
        </a>
        <a href="/admin/releases">
          <span>Releases</span>
          <span class="link-desc">Build and promote</span>
        </a>
        <a href="/admin/jobs">
          <span>Jobs</span>
          <span class="link-desc">Source updates, Gemini</span>
        </a>
      </div>
    </div>

    <div class="two-col">
      <div class="stack">
        <div class="section">
          <h2>Status</h2>
          <h3>Translations</h3>
          ${renderDefinitionList(data.translationCounts)}
          <h3 style="margin-top: var(--space-5)">Example Sets</h3>
          ${renderDefinitionList(data.exampleSetCounts)}
          <h3 style="margin-top: var(--space-5)">Reviews</h3>
          ${renderDefinitionList(data.reviewCounts)}
        </div>
      </div>
      <div class="stack">
        <div class="section">
          <h2>Recent Batches</h2>
          ${renderBatchTable(data.recentBatches)}
        </div>
      </div>
    </div>
  `)
}

function shortenUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device'
  const trimmed = ua.length > 80 ? `${ua.slice(0, 80)}…` : ua
  return trimmed
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC'
  } catch {
    return iso
  }
}

export interface AccountPageData {
  email: string
  lastLoginAt: string | null
  sessions: Array<{
    id: number
    createdAt: string
    expiresAt: string
    userAgent: string | null
    ip: string | null
  }>
  flash?: { kind: 'success' | 'error'; message: string } | null
}

export function renderAdminAccountPage(data: AccountPageData): string {
  const flashHtml = data.flash
    ? `<div class="alert ${data.flash.kind === 'success' ? 'success' : 'error'}">
         <p>${escapeHtml(data.flash.message)}</p>
       </div>`
    : ''

  const sessionRows =
    data.sessions.length === 0
      ? '<div class="empty">No active sessions.</div>'
      : `<table class="data-table">
          <thead>
            <tr><th>Device</th><th>IP</th><th>Created</th><th>Expires</th><th></th></tr>
          </thead>
          <tbody>
            ${data.sessions
              .map(
                (session) => `
                <tr>
                  <td>${escapeHtml(shortenUserAgent(session.userAgent))}</td>
                  <td>${escapeHtml(session.ip ?? 'unknown')}</td>
                  <td>${escapeHtml(formatDate(session.createdAt))}</td>
                  <td>${escapeHtml(formatDate(session.expiresAt))}</td>
                  <td>
                    <form action="/admin/account/sessions/${session.id}/revoke" method="POST" class="inline-form">
                      <button type="submit" class="danger-button">Revoke</button>
                    </form>
                  </td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>`

  return renderPage(
    'Account',
    `
    <div class="page-header">
      <h1>Account</h1>
    </div>

    ${flashHtml}

    <div class="section">
      <h2>Profile</h2>
      <dl class="definition-list">
        <dt>Email</dt><dd>${escapeHtml(data.email)}</dd>
        <dt>Last login</dt><dd>${escapeHtml(data.lastLoginAt ? formatDate(data.lastLoginAt) : 'never')}</dd>
      </dl>
    </div>

    <div class="section">
      <h2>Change password</h2>
      <form action="/admin/account/change-password" method="POST" class="auth-form">
        <label>Current password
          <input type="password" name="currentPassword" autocomplete="current-password" required />
        </label>
        <label>New password (min 12 characters)
          <input type="password" name="newPassword" autocomplete="new-password" minlength="12" required />
        </label>
        <label>Confirm new password
          <input type="password" name="confirmPassword" autocomplete="new-password" minlength="12" required />
        </label>
        <button type="submit">Update password</button>
      </form>
      <p class="auth-footnote">Updates the password and signs you out everywhere.</p>
    </div>

    <div class="section">
      <h2>Active sessions</h2>
      <p class="text-sm text-muted" style="margin-top: calc(-1 * var(--space-2)); margin-bottom: var(--space-4)">Revoking a session signs that device out on next refresh.</p>
      ${sessionRows}
    </div>
  `
  )
}

export function renderNewWordPage(): string {
  return renderPage('New Word', `
    <div class="page-header">
      <h1>New Word</h1>
      <p>Writes to snapshot. Build a release to make it searchable.</p>
    </div>

    <form action="/admin/api/new-word" method="POST" data-new-word-form="true">
      <div class="panel">
        <div class="section-header">
          <h2>Core Fields</h2>
        </div>
        <div class="form-grid">
          <label>Word
            <input type="text" name="word" class="input-lg" placeholder="新語" />
          </label>
          <label>Reading
            <input type="text" name="reading" class="input-lg" placeholder="しんご" />
          </label>
          <label>Part of speech
            <input type="text" name="partOfSpeech" placeholder="noun, expression" />
          </label>
          <label>JLPT
            <select name="jlpt">
              <option value="">(none)</option>
              <option value="5">N5</option>
              <option value="4">N4</option>
              <option value="3">N3</option>
              <option value="2">N2</option>
              <option value="1">N1</option>
            </select>
          </label>
        </div>
        <label class="checkbox-label">
          <input type="checkbox" name="common" />
          Mark as common word
        </label>
      </div>

      <div class="panel">
        <div class="section-header">
          <h2>Translations</h2>
          <button type="button" class="secondary" data-add-translation>Add language</button>
        </div>
        <div data-translation-list class="stack"></div>
      </div>

      <div class="panel">
        <div class="section-header">
          <h2>Submit Summary</h2>
        </div>
        <dl class="stat-list" style="max-width: 480px">
          <dt>Preview word ID</dt><dd><code data-word-id-preview>waiting for word + reading</code></dd>
          <dt>Publish mode</dt><dd>Snapshot first</dd>
          <dt>Next step</dt><dd>Build release</dd>
        </dl>
        <div class="page-actions">
          <button type="submit">Save new word</button>
          <a href="/admin/releases">Open releases</a>
        </div>
      </div>

      <div data-new-word-errors></div>
      <div data-new-word-warnings></div>
      <div data-new-word-success></div>
    </form>
  `)
}

export function renderEntryPage(data: AdminEntryInspectionResponse): string {
  const word = data.word
  return renderPage('Entry Inspector', `
    <div class="page-header">
      <h1>Entry Inspector</h1>
    </div>

    <form method="GET" action="/admin/entry" class="inline-form" style="margin-bottom: var(--space-6)">
      <label>Word
        <input type="text" name="word" value="${escapeHtml(data.query.word)}" placeholder="食べる" class="input-lg" />
      </label>
      <label>Language
        <select name="lang">
          ${(['en', 'de', 'ko', 'zh-cn', 'zh-tw'] as Language[]).map((lang) => `
            <option value="${lang}" ${data.query.lang === lang ? 'selected' : ''}>${lang}</option>
          `).join('')}
        </select>
      </label>
      <button type="submit">Look up</button>
    </form>

    ${word ? `
      <div class="entry-section" style="border-top: 2px solid var(--border); padding-top: var(--space-5)">
        <div style="display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3)">
          <span class="entry-word">${escapeHtml(word.word)}</span>
          ${word.reading !== word.word ? `<span class="entry-reading">${escapeHtml(word.reading)}</span>` : ''}
          <div class="badge-row" style="margin-left: var(--space-2)">
            ${word.partOfSpeech.map((pos) => `<span class="badge">${escapeHtml(pos)}</span>`).join('')}
          </div>
        </div>
        ${word.frequency ? `<div class="entry-detail">Frequency rank: ${escapeHtml(word.frequency)}</div>` : ''}
      </div>

      ${data.effective ? `
        <div class="entry-section">
          <h3>Effective Lookup</h3>
          <p class="text-sm text-muted" style="margin-bottom: var(--space-3)">What users see — merged from all layers.</p>
          <ol class="entry-definitions">
            ${data.effective.definitions.map((def) => `<li>${escapeHtml(def)}</li>`).join('')}
          </ol>
          ${data.effective.examples.length > 0 ? `
            <div class="entry-examples" style="margin-top: var(--space-4)">
              ${data.effective.examples.map((ex) => `
                <div class="entry-example-row">
                  <span class="entry-example-jp">${escapeHtml(ex.japanese)}</span>
                  <span>${escapeHtml(ex.translation)}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
          ${jsonBlock(data.effective)}
        </div>
      ` : ''}

      <div class="entry-section">
        <h3>Release Layer</h3>
        ${data.release ? `
          <ol class="entry-definitions">
            ${data.release.definitions.map((def) => `<li>${escapeHtml(def)}</li>`).join('')}
          </ol>
          ${data.release.examples.length > 0 ? `
            <div class="entry-examples" style="margin-top: var(--space-3)">
              ${data.release.examples.map((ex) => `
                <div class="entry-example-row">
                  <span class="entry-example-jp">${escapeHtml(ex.japanese)}</span>
                  <span>${escapeHtml(ex.translation)}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
          <div class="item-meta">Sources: ${escapeHtml(data.release.sources.join(', '))}</div>
          ${jsonBlock(data.release)}
        ` : '<div class="text-muted text-sm">No release data for this entry.</div>'}
      </div>

      <div class="entry-section">
        <h3>Source Update Layer</h3>
        ${data.sourceUpdate.translation ? `
          <div class="badge-row" style="margin-bottom: var(--space-2)">${renderBadge(data.sourceUpdate.translation.status)} ${renderBadge(data.sourceUpdate.translation.reviewStatus)}</div>
          <ol class="entry-definitions">
            ${data.sourceUpdate.translation.definitions.map((def) => `<li>${escapeHtml(def)}</li>`).join('')}
          </ol>
          ${jsonBlock(data.sourceUpdate)}
        ` : '<div class="text-muted text-sm">No source updates for this entry.</div>'}
      </div>

      <div class="entry-section">
        <h3>AI Update Layer</h3>
        ${data.aiUpdate.translation ? `
          <div class="badge-row" style="margin-bottom: var(--space-2)">${renderBadge(data.aiUpdate.translation.status)} ${renderBadge(data.aiUpdate.translation.reviewStatus)} ${renderBadge(data.aiUpdate.translation.sourceType)}</div>
          <ol class="entry-definitions">
            ${data.aiUpdate.translation.definitions.map((def) => `<li>${escapeHtml(def)}</li>`).join('')}
          </ol>
          ${jsonBlock(data.aiUpdate)}
        ` : '<div class="text-muted text-sm">No AI updates for this entry.</div>'}
      </div>
    ` : data.query.word ? `
      <div class="empty" style="margin-top: var(--space-5)">
        No entry found for <strong class="text-jp">${escapeHtml(data.query.word)}</strong> in <strong>${escapeHtml(data.query.lang)}</strong>.
        Try a different reading or check that the word exists in the release.
      </div>
    ` : ''}
  `)
}

export function renderReviewPage(data: AdminReviewQueueResponseV2): string {
  return renderPage('AI Review Queue', `
    <div class="page-header">
      <h1>AI Review</h1>
      <p>${data.summary.pendingUnits > 0
        ? `${data.summary.pendingUnits} unit${data.summary.pendingUnits === 1 ? '' : 's'} pending.`
        : 'All caught up.'
      }</p>
      <div class="page-meta">Release ${escapeHtml(data.releaseVersion)}</div>
    </div>

    ${renderReviewSummaryCards(data.summary)}

    <div class="section">
      <h2>Pending Batches</h2>
      ${renderRecentReviewBatches(data.summary.recentBatches)}
    </div>

    <div class="section">
      <h2>Review Units</h2>
      ${renderReviewFilterChips('/admin/review', {
        risk: data.filters.risk,
        shape: data.filters.shape,
        hasSourceConflict: data.filters.hasSourceConflict,
      })}
      ${renderReviewUnitList(data.items)}
      ${data.nextCursor ? `
        <div class="page-actions">
          <a href="${buildReviewPageLink('/admin/review', {
            cursor: data.nextCursor,
            risk: data.filters.risk,
            shape: data.filters.shape,
            hasSourceConflict: data.filters.hasSourceConflict === null ? null : String(data.filters.hasSourceConflict),
          })}">Next page</a>
        </div>
      ` : ''}
    </div>
  `)
}

export function renderReviewBatchPage(data: AdminReviewBatchPageResponse): string {
  const batchId = data.summary.batch?.id ?? ''
  const batchPath = `/admin/review/batch/${batchId}`
  return renderPage('AI Review Batch', `
    <div class="page-header">
      <h1>Batch ${escapeHtml(batchId)}</h1>
      <div class="page-meta">Release ${escapeHtml(data.releaseVersion)}</div>
    </div>

    <div class="section">
      <h2>Batch Summary</h2>
      ${renderReviewSummaryCards(data.summary)}
    </div>

    <div class="section">
      <h2>Review Units</h2>
      ${renderReviewFilterChips(batchPath, {
        risk: data.filters.risk,
        shape: data.filters.shape,
        hasSourceConflict: data.filters.hasSourceConflict,
      })}
      <div class="selection-bar">
        <div class="btn-group">
          <button type="button" class="secondary" data-review-select-all>Select all visible</button>
          <button type="button" class="secondary" data-review-clear-all>Clear</button>
        </div>
        <form action="/admin/api/review/units/approve" method="POST" data-json-form="true" data-reload="true" data-review-bulk-form="true" class="inline-form">
          <div data-selected-unit-ids></div>
          <label class="checkbox-inline">
            <input type="checkbox" name="overrideSourceConflict" value="true" />
            Override source conflicts
          </label>
          <button type="submit">Approve selected</button>
          <button type="submit" class="secondary" formaction="/admin/api/review/units/reject" data-confirm="Reject selected review units?">Reject selected</button>
          <div class="result" data-result></div>
        </form>
      </div>
      ${renderReviewUnitList(data.items)}
      ${data.nextCursor ? `
        <div class="page-actions">
          <a href="${buildReviewPageLink(batchPath, {
            cursor: data.nextCursor,
            risk: data.filters.risk,
            shape: data.filters.shape,
            hasSourceConflict: data.filters.hasSourceConflict === null ? null : String(data.filters.hasSourceConflict),
          })}">Next page</a>
        </div>
      ` : ''}
    </div>
  `)
}

export function renderReleasesPage(data: AdminReleaseListResponse): string {
  return renderPage('Releases', `
    <div class="page-header">
      <h1>Releases</h1>
      <div class="page-meta">Active: ${escapeHtml(data.activeReleaseVersion)}</div>
    </div>

    <div class="section">
      <h2>Release Inventory</h2>
      ${renderReleaseTable(data.releases)}
    </div>

    <div class="two-col">
      <div class="panel">
        <h2>Build New Release</h2>
        <form action="/admin/api/releases/build" method="POST" data-json-form="true" data-reload="true">
          <div class="form-grid">
            <label>Version override
              <input type="text" name="version" placeholder="auto-generated" />
            </label>
            <label>Mode
              <select name="activate">
                <option value="true">Build and activate</option>
                <option value="false">Build only</option>
              </select>
            </label>
          </div>
          <button type="submit">Build release</button>
          <div class="result" data-result></div>
        </form>
      </div>
      <div class="panel">
        <h2>Promote Updates</h2>
        <form action="/admin/api/releases/promote" method="POST" data-json-form="true" data-reload="true">
          <div class="form-grid">
            <label>Version override
              <input type="text" name="version" placeholder="auto-generated" />
            </label>
            <label>Mode
              <select name="activate">
                <option value="true">Promote and activate</option>
                <option value="false">Promote only</option>
              </select>
            </label>
          </div>
          <button type="submit" data-confirm="Promote current effective updates into a new release?">Promote release</button>
          <div class="result" data-result></div>
        </form>
      </div>
    </div>
  `)
}

export function renderJobsPage(
  batches: UpdateBatchRecord[],
  batchDetail: AdminBatchDetailResponse | null
): string {
  return renderPage('Jobs', `
    <div class="page-header">
      <h1>Jobs</h1>
    </div>

    <div class="two-col" style="margin-bottom: var(--space-7)">
      <div class="panel">
        <h2>Source Update</h2>
        <form action="/admin/api/jobs/source-update" method="POST" data-json-form="true">
          <div class="form-grid">
            <label>Languages
              <input type="text" name="langs" placeholder="en,de,ko,zh-cn,zh-tw" />
            </label>
            <label>Mode
              <select name="dryRun">
                <option value="false">Write updates</option>
                <option value="true">Dry run</option>
              </select>
            </label>
          </div>
          <button type="submit">Run source update</button>
          <div class="result" data-result></div>
        </form>
      </div>
      <div class="panel">
        <h2>Gemini Import</h2>
        <form action="/admin/api/jobs/gemini-import" method="POST" data-json-form="true">
          <div class="form-grid">
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
            <label>Scope
              <select name="commonOnly">
                <option value="true">Common only</option>
                <option value="false">All entries</option>
              </select>
            </label>
            <label>Max cost USD
              <input type="text" name="maxCostUsd" value="2" />
            </label>
            <label>Mode
              <select name="dryRun">
                <option value="true">Dry run</option>
                <option value="false">Write pending reviews</option>
              </select>
            </label>
          </div>
          <button type="submit">Run Gemini import</button>
          <div class="result" data-result></div>
        </form>
      </div>
    </div>

    <div class="section">
      <h2>Batch History</h2>
      ${renderBatchTable(batches)}
    </div>

    ${batchDetail ? `
      <div class="section">
        <h2>Batch ${batchDetail.batch?.id ?? 'n/a'} Detail</h2>
        ${batchDetail.batch ? `
          <dl class="stat-list" style="max-width: 400px; margin-bottom: var(--space-4)">
            <dt>Kind</dt><dd>${escapeHtml(batchDetail.batch.kind)}</dd>
            <dt>Status</dt><dd>${escapeHtml(batchDetail.batch.status)}</dd>
            <dt>Actor</dt><dd>${escapeHtml(batchDetail.batch.actor ?? 'system')}</dd>
            <dt>Created</dt><dd>${formatTimestamp(batchDetail.batch.createdAt)}</dd>
            ${batchDetail.batch.completedAt ? `<dt>Completed</dt><dd>${formatTimestamp(batchDetail.batch.completedAt)}</dd>` : ''}
            ${batchDetail.batch.errorMessage ? `<dt>Error</dt><dd style="color: var(--negative)">${escapeHtml(batchDetail.batch.errorMessage)}</dd>` : ''}
          </dl>
          ${jsonBlock(batchDetail.batch.inputManifest, 'View input manifest')}
        ` : ''}

        ${batchDetail.translations.length > 0 ? `
          <h3 style="margin-top: var(--space-5)">Translation Updates</h3>
          ${renderTranslationCards(batchDetail.translations)}
        ` : ''}

        ${batchDetail.exampleSets.length > 0 ? `
          <h3 style="margin-top: var(--space-5)">Example Update Sets</h3>
          ${renderExampleCards(batchDetail.exampleSets)}
        ` : ''}
      </div>
    ` : ''}
  `)
}

export function renderUpdatesPage(data: AdminUpdatesResponse): string {
  const currentFilters = {
    lang: null as string | null,
    sourceType: null as string | null,
    status: null as string | null,
    reviewStatus: null as string | null,
  }
  // Extract current filters from the URL via the data
  // We detect applied filters by checking if data has specific subsets
  // The filter bar will use URL params which are re-parsed by the route handler
  return renderPage('Updates Explorer', `
    <div class="page-header">
      <h1>Updates</h1>
      <div class="page-meta">Release ${escapeHtml(data.releaseVersion)}</div>
    </div>

    ${renderFilterBar(currentFilters)}

    <div class="two-col">
      <div class="section">
        <h2>Translation Updates</h2>
        ${renderTranslationCards(data.translations)}
      </div>
      <div class="section">
        <h2>Example Update Sets</h2>
        ${renderExampleCards(data.exampleSets)}
      </div>
    </div>

    <div class="section" style="margin-top: var(--space-5)">
      <h2>Verification Summary</h2>
      <div class="two-col">
        <div>
          <h3>Translations</h3>
          ${renderDefinitionList(data.verification.translationCounts)}
          <h3 style="margin-top: var(--space-4)">Example Sets</h3>
          ${renderDefinitionList(data.verification.exampleSetCounts)}
        </div>
        <div>
          <h3>Reviews</h3>
          ${renderDefinitionList(data.verification.reviewCounts)}
          <h3 style="margin-top: var(--space-4)">Stats</h3>
          <dl class="stat-list">
            <dt>Active reviewed AI</dt><dd>${escapeHtml(data.verification.activeReviewedAiCount)}</dd>
            <dt>Orphaned word IDs</dt><dd>${escapeHtml(data.verification.orphanedWordIds.length)}</dd>
          </dl>
          ${data.verification.orphanedWordIds.length > 0 ? `
            ${jsonBlock(data.verification.orphanedWordIds, 'View orphaned word IDs')}
          ` : ''}
        </div>
      </div>
    </div>
  `)
}
