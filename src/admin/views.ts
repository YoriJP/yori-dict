import type {
  AdminBatchDetailResponse,
  AdminEntryInspectionResponse,
  AdminNewWordResponse,
  AdminReviewBatchPageResponse,
  AdminReviewBatchSummaryResponse,
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

function renderPage(title: string, body: string): string {
  const navHtml = NAV_ITEMS.map(item =>
    `<a href="${item.href}" ${title.includes(item.match) ? 'aria-current="page"' : ''}>${item.label}</a>`
  ).join('\n          ')

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
        --surface-sidebar: oklch(22% 0.018 var(--hue));

        --text-primary: oklch(22% 0.02 var(--hue));
        --text-secondary: oklch(45% 0.03 var(--hue));
        --text-tertiary: oklch(58% 0.025 var(--hue));
        --text-on-dark: oklch(90% 0.01 var(--hue));
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

        --border: oklch(88% 0.012 var(--hue));
        --border-strong: oklch(78% 0.018 var(--hue));

        --text-xs: clamp(0.6875rem, 0.65rem + 0.15vw, 0.75rem);
        --text-sm: clamp(0.8125rem, 0.78rem + 0.15vw, 0.875rem);
        --text-base: clamp(0.9375rem, 0.9rem + 0.2vw, 1rem);
        --text-lg: clamp(1.125rem, 1rem + 0.4vw, 1.25rem);
        --text-xl: clamp(1.5rem, 1.2rem + 0.8vw, 1.875rem);
        --text-2xl: clamp(2rem, 1.5rem + 1.2vw, 2.5rem);

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

        --radius-sm: 4px;
        --radius-md: 8px;
        --radius-lg: 12px;
      }

      *, *::before, *::after { box-sizing: border-box; margin: 0; }

      body {
        font-family: var(--font-body);
        font-size: var(--text-base);
        color: var(--text-primary);
        background: var(--surface-0);
        line-height: 1.55;
        -webkit-font-smoothing: antialiased;
      }

      /* -- Layout shell -- */
      .shell {
        display: grid;
        grid-template-columns: 220px 1fr;
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
        font-size: var(--text-xl);
        font-weight: 700;
        color: var(--text-on-dark);
        padding: 0 var(--space-5);
        margin-bottom: var(--space-7);
        letter-spacing: -0.02em;
      }
      .sidebar-brand span {
        font-weight: 300;
        font-size: var(--text-sm);
        display: block;
        color: oklch(65% 0.02 var(--hue));
        margin-top: var(--space-1);
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .sidebar nav {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
      }
      .sidebar nav a {
        display: block;
        padding: var(--space-3) var(--space-5);
        color: oklch(72% 0.015 var(--hue));
        text-decoration: none;
        font-size: var(--text-sm);
        font-weight: 400;
        border-left: 3px solid transparent;
        transition: color 120ms, background 120ms, border-color 120ms;
      }
      .sidebar nav a:hover {
        color: var(--text-on-dark);
        background: oklch(28% 0.015 var(--hue));
      }
      .sidebar nav a[aria-current="page"] {
        color: var(--text-on-dark);
        background: oklch(28% 0.02 var(--hue));
        border-left-color: var(--accent);
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
        max-width: 1000px;
      }

      /* -- Typography -- */
      h1, h2, h3, h4 {
        font-family: var(--font-display);
        line-height: 1.2;
        letter-spacing: -0.015em;
      }
      h1 {
        font-size: var(--text-2xl);
        font-weight: 700;
        margin-bottom: var(--space-2);
      }
      h2 {
        font-size: var(--text-lg);
        font-weight: 700;
        margin-bottom: var(--space-4);
      }
      h3 {
        font-size: var(--text-base);
        font-weight: 600;
        margin-bottom: var(--space-2);
      }

      .page-header {
        margin-bottom: var(--space-7);
      }
      .page-header p {
        color: var(--text-secondary);
        max-width: 600px;
        margin-top: var(--space-2);
      }

      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .text-muted { color: var(--text-secondary); }
      .text-tertiary { color: var(--text-tertiary); }
      .text-sm { font-size: var(--text-sm); }
      .text-mono { font-family: var(--font-mono); }
      .text-jp { font-family: var(--font-jp); }

      /* -- Metric strip -- */
      .metric-strip {
        display: flex;
        gap: var(--space-6);
        padding: var(--space-5) 0;
        border-top: 2px solid var(--border);
        border-bottom: 1px solid var(--border);
        margin-bottom: var(--space-6);
        flex-wrap: wrap;
      }
      .metric-item {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        padding-right: var(--space-6);
        border-right: 1px solid var(--border);
      }
      .metric-item:last-child {
        border-right: none;
        padding-right: 0;
      }
      .metric-value {
        font-family: var(--font-display);
        font-size: var(--text-xl);
        font-weight: 700;
        line-height: 1;
        letter-spacing: -0.02em;
      }
      .metric-label {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.06em;
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
        gap: var(--space-6);
      }
      .stack { display: grid; gap: var(--space-5); align-content: start; }

      /* -- Tables -- */
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th {
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        padding: var(--space-2) var(--space-3);
        padding-left: 0;
        border-bottom: 2px solid var(--border);
        text-align: left;
      }
      td {
        padding: var(--space-3);
        padding-left: 0;
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
        padding: 2px var(--space-2);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
        line-height: 1.4;
      }
      .badge::before {
        content: '';
        width: 6px;
        height: 6px;
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
        gap: var(--space-2);
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
        gap: var(--space-3);
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
        gap: var(--space-1);
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
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
        transition: border-color 150ms, box-shadow 150ms;
      }
      input:focus, select:focus, textarea:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px oklch(52% 0.16 45 / 10%);
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
      button {
        font-family: var(--font-body);
        font-size: var(--text-sm);
        font-weight: 600;
        border-radius: var(--radius-sm);
        border: none;
        padding: var(--space-2) var(--space-4);
        cursor: pointer;
        background: var(--accent);
        color: var(--surface-2);
        transition: background 120ms;
        white-space: nowrap;
      }
      button:hover {
        background: var(--accent-hover);
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
      button.sm {
        font-size: var(--text-xs);
        padding: var(--space-1) var(--space-3);
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
        border-color: oklch(90% 0.04 25);
      }
      .alert.warning {
        background: var(--caution-subtle);
        border-color: oklch(91% 0.04 85);
      }
      .alert.success {
        background: var(--positive-subtle);
        border-color: oklch(90% 0.04 155);
      }
      .alert h3 {
        margin-bottom: var(--space-2);
      }
      .alert ul {
        margin: 0;
        padding-left: var(--space-5);
      }
      .alert + .alert {
        margin-top: var(--space-3);
      }
      .translation-card {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        background: var(--surface-2);
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
        flex-wrap: wrap;
        margin-top: var(--space-4);
      }
      .selection-bar {
        display: flex;
        gap: var(--space-3);
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--surface-2);
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
      .filter-chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin: var(--space-4) 0;
      }
      .filter-chip {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--border);
        border-radius: 999px;
        text-decoration: none;
        color: var(--text-secondary);
        background: var(--surface-2);
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .filter-chip[aria-current="page"] {
        color: var(--accent);
        border-color: oklch(83% 0.04 var(--hue));
        background: var(--accent-subtle);
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-3);
      }
      .summary-card {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        background: var(--surface-2);
      }
      .summary-card h3 {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: var(--space-2);
      }
      .summary-card .metric-value {
        display: block;
        font-size: var(--text-xl);
      }

      /* -- Lists & items -- */
      .item-list {
        display: grid;
        gap: 0;
      }
      .item {
        padding: var(--space-4) 0;
        border-bottom: 1px solid var(--border);
      }
      .item:first-child {
        padding-top: 0;
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
        font-size: var(--text-sm);
        color: var(--text-tertiary);
        font-weight: 400;
        margin-left: var(--space-2);
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
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: var(--space-3);
        margin-top: var(--space-3);
      }
      .diff-block {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--surface-2);
        padding: var(--space-3);
      }
      .diff-block h4 {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
        margin-bottom: var(--space-2);
      }
      .diff-block ul {
        margin: 0;
        padding-left: var(--space-4);
      }
      .diff-block li {
        font-size: var(--text-xs);
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
        text-align: right;
      }

      /* -- Quick links -- */
      .quick-links {
        display: grid;
        gap: var(--space-2);
      }
      .quick-links a {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-2) 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        text-decoration: none;
        transition: color 120ms;
      }
      .quick-links a:hover {
        color: var(--accent);
        text-decoration: none;
      }
      .quick-links a::after {
        content: '\\2192';
        color: var(--text-tertiary);
        transition: transform 120ms, color 120ms;
      }
      .quick-links a:hover::after {
        transform: translateX(3px);
        color: var(--accent);
      }
      .quick-links .link-desc {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
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
        line-height: 1.2;
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
        font-family: var(--font-body);
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
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

      /* -- Panels (used sparingly) -- */
      .panel {
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
      }

      /* -- Empty states -- */
      .empty {
        padding: var(--space-6) var(--space-5);
        color: var(--text-tertiary);
        font-size: var(--text-sm);
        text-align: left;
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
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
          transition: left 200ms;
        }
        .sidebar.open {
          left: 0;
        }
        .mobile-toggle {
          display: block;
        }
        .content {
          padding: var(--space-7) var(--space-4) var(--space-8);
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
        .metric-item {
          border-right: none;
          padding-right: 0;
          border-bottom: 1px solid var(--border);
          padding-bottom: var(--space-4);
        }
        .metric-item:last-child {
          border-bottom: none;
          padding-bottom: 0;
        }
        .entry-example-row {
          grid-template-columns: 1fr;
        }
        .example-row,
        .list-row {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
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
        ${body}
      </main>
    </div>
    <script>
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
    </script>
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

function renderReviewUnitList(items: ReviewUnit[]): string {
  if (items.length === 0) return '<div class="empty">No pending review units match this view.</div>'
  return `<div class="item-list">${items.map(renderReviewUnit).join('')}</div>`
}

function renderReviewSummaryCards(summary: AdminReviewQueueResponseV2['summary'] | AdminReviewBatchSummaryResponse): string {
  const cards: Array<{ title: string; body: string }> = [
    { title: 'Pending Units', body: `<span class="metric-value">${escapeHtml(summary.pendingUnits)}</span>` },
    { title: 'Languages', body: renderDefinitionList(summary.byLanguage) },
    { title: 'Risk', body: renderDefinitionList(summary.byRisk as Record<string, number>) },
    { title: 'Source Conflict', body: `<span class="metric-value">${escapeHtml(summary.sourceConflictCount)}</span>` },
  ]

  if ('translationOnlyCount' in summary) {
    cards.push({
      title: 'Split Units',
      body: `<dl class="stat-list"><dt>Translation only</dt><dd>${escapeHtml(summary.translationOnlyCount)}</dd><dt>Examples only</dt><dd>${escapeHtml(summary.examplesOnlyCount)}</dd></dl>`,
    })
  }

  return `<div class="summary-grid">
    ${cards.map((card) => `
      <div class="summary-card">
        <h3>${escapeHtml(card.title)}</h3>
        ${card.body}
      </div>
    `).join('')}
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
  return renderPage('Dashboard', `
    <div class="page-header">
      <h1>Dashboard</h1>
      <p>Overview of releases, AI reviews, and update activity.</p>
    </div>

    <div class="metric-strip">
      <div class="metric-item">
        <span class="metric-value">${escapeHtml(data.activeReleaseVersion)}</span>
        <span class="metric-label">Active Release</span>
      </div>
      <div class="metric-item">
        <span class="metric-value">${escapeHtml((data.reviewCounts['translation:pending'] ?? 0) + (data.reviewCounts['example:pending'] ?? 0))}</span>
        <span class="metric-label">Pending Review</span>
      </div>
      <div class="metric-item">
        <span class="metric-value">${escapeHtml(data.orphanedWordIdsCount)}</span>
        <span class="metric-label">Orphaned Updates</span>
      </div>
      <div class="metric-item">
        <span class="metric-value">${escapeHtml(data.activeReviewedAiCount)}</span>
        <span class="metric-label">Reviewed AI</span>
      </div>
    </div>

    <div class="two-col">
      <div class="stack">
        <div class="section">
          <h2>Status Breakdown</h2>
          <h3>Translations</h3>
          ${renderDefinitionList(data.translationCounts)}
          <h3 style="margin-top: var(--space-4)">Example Sets</h3>
          ${renderDefinitionList(data.exampleSetCounts)}
          <h3 style="margin-top: var(--space-4)">Reviews</h3>
          ${renderDefinitionList(data.reviewCounts)}
        </div>
        <div class="section">
          <h2>Recent Batches</h2>
          ${renderBatchTable(data.recentBatches)}
        </div>
      </div>
      <div class="stack">
        <div class="section">
          <h2>Quick Actions</h2>
          <div class="quick-links">
            <a href="/admin/entry">
              <div>
                <div>Entry Inspector</div>
                <div class="link-desc">Compare release, source, AI, and effective layers</div>
              </div>
            </a>
            <a href="/admin/review">
              <div>
                <div>AI Review Queue</div>
                <div class="link-desc">Approve or reject pending AI translations</div>
              </div>
            </a>
            <a href="/admin/new-word">
              <div>
                <div>New Word</div>
                <div class="link-desc">Create a new deterministic word and add it to the next release</div>
              </div>
            </a>
            <a href="/admin/releases">
              <div>
                <div>Release Management</div>
                <div class="link-desc">Build, activate, and promote releases</div>
              </div>
            </a>
            <a href="/admin/jobs">
              <div>
                <div>Jobs</div>
                <div class="link-desc">Run source updates or Gemini imports</div>
              </div>
            </a>
          </div>
        </div>
      </div>
    </div>
  `)
}

export function renderNewWordPage(): string {
  return renderPage('New Word', `
    <div class="page-header">
      <h1>New Word</h1>
      <p>Create a new deterministic dictionary entry. This writes to snapshot JSON only; build a new release afterwards to make the word searchable.</p>
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
      <p>Look up any word and compare data across release, source, AI, and effective layers.</p>
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
      <p>
        ${data.summary.pendingUnits > 0
          ? `${data.summary.pendingUnits} review unit${data.summary.pendingUnits === 1 ? '' : 's'} pending.`
          : 'All caught up.'
        }
        Queue is grouped by word, language, and batch so large AI imports can be reviewed in bulk.
      </p>
      <div class="text-sm text-muted" style="margin-top: var(--space-1)">Release: ${escapeHtml(data.releaseVersion)}</div>
    </div>

    <div class="section">
      <h2>Queue Summary</h2>
      ${renderReviewSummaryCards(data.summary)}
    </div>

    <div class="section">
      <h2>Pending Batches</h2>
      ${renderRecentReviewBatches(data.summary.recentBatches)}
    </div>

    <div class="section">
      <h2>Visible Units</h2>
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
      <h1>Batch Review</h1>
      <p>Review AI candidates grouped into queue units for a single import batch.</p>
      <div class="text-sm text-muted" style="margin-top: var(--space-1)">Batch: ${escapeHtml(batchId)} &middot; Release: ${escapeHtml(data.releaseVersion)}</div>
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
      <p>Build immutable snapshots, promote updates, and manage which release is active.</p>
      <div class="text-sm text-muted" style="margin-top: var(--space-1)">Active: ${escapeHtml(data.activeReleaseVersion)}</div>
    </div>

    <div class="section">
      <h2>Release Inventory</h2>
      ${renderReleaseTable(data.releases)}
    </div>

    <div class="two-col">
      <div class="panel">
        <h2>Build New Release</h2>
        <form action="/admin/api/releases/build" method="POST" data-json-form="true" data-reload="true">
          <label>Version override
            <input type="text" name="version" placeholder="auto-generated if empty" />
          </label>
          <label>Mode
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
        <h2>Promote Updates</h2>
        <p class="text-sm text-muted" style="margin-bottom: var(--space-3)">Bake current effective updates into a new release.</p>
        <form action="/admin/api/releases/promote" method="POST" data-json-form="true" data-reload="true">
          <label>Version override
            <input type="text" name="version" placeholder="auto-generated if empty" />
          </label>
          <label>Mode
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
  `)
}

export function renderJobsPage(
  batches: UpdateBatchRecord[],
  batchDetail: AdminBatchDetailResponse | null
): string {
  return renderPage('Jobs', `
    <div class="page-header">
      <h1>Jobs</h1>
      <p>Trigger source updates or Gemini AI imports, and inspect batch history.</p>
    </div>

    <div class="two-col" style="margin-bottom: var(--space-7)">
      <div class="panel">
        <h2>Source Update</h2>
        <p class="text-sm text-muted" style="margin-bottom: var(--space-3)">Run deterministic updates from upstream data sources.</p>
        <form action="/admin/api/jobs/source-update" method="POST" data-json-form="true">
          <label>Languages
            <input type="text" name="langs" placeholder="en,de,ko,zh-cn,zh-tw" />
          </label>
          <label>Mode
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
        <h2>Gemini Import</h2>
        <p class="text-sm text-muted" style="margin-bottom: var(--space-3)">Generate AI translations and examples via Gemini.</p>
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
      <p>Browse all translation and example updates across source and AI layers.</p>
      <div class="text-sm text-muted" style="margin-top: var(--space-1)">Release: ${escapeHtml(data.releaseVersion)}</div>
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
