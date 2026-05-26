import { describe, expect, test } from 'bun:test'
import { renderDashboardPage } from '../src/admin/views'
import type { AdminSummaryResponse } from '../src/admin/types'

function makeSummary(overrides: Partial<AdminSummaryResponse> = {}): AdminSummaryResponse {
  return {
    activeReleaseVersion: 'test-release',
    activeReleaseMode: 'env',
    releaseWordCount: 2,
    translationCounts: {},
    exampleSetCounts: {},
    reviewCounts: {},
    orphanedWordIdsCount: 0,
    activeReviewedAiCount: 0,
    recentBatches: [],
    ...overrides,
  }
}

describe('admin dashboard view', () => {
  test('does not show fresh-install guidance when the active release has words', () => {
    const html = renderDashboardPage(makeSummary())

    expect(html).toContain('2 words')
    expect(html).toContain('Nothing needs attention right now.')
    expect(html).not.toContain('Getting started: run a source update')
    expect(html).not.toContain('The active release has no words')
  })

  test('shows first-release guidance only when the active release is empty', () => {
    const html = renderDashboardPage(makeSummary({ releaseWordCount: 0 }))

    expect(html).toContain('0 words')
    expect(html).toContain('Getting started: run a source update')
    expect(html).toContain('The active release has no words')
  })
})
