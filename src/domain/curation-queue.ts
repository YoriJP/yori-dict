import type { CanonicalSnapshot, Entry, Gloss, Sense, SourceRef, TargetLanguage } from './types'

export type CurationQueueItemType = 'missingGloss'

export interface CurationQueueGloss {
  lang: TargetLanguage
  text: string
  sourceType: 'source' | 'manual' | 'ai'
}

export interface CurationQueueItem {
  id: string
  type: CurationQueueItemType
  priority: number
  targetLang: TargetLanguage
  entryId: string
  senseId: string
  primaryForm: string
  primaryReading: string
  senseOrder: number
  partOfSpeech: string[]
  reason: string
  sourceGlosses: CurationQueueGloss[]
  inputRefs: string[]
}

export interface CurationQueue {
  schemaVersion: '1.0.0'
  generatedAt: string
  snapshotGeneratedAt: string
  targetLang: TargetLanguage
  summary: {
    itemCount: number
    totalCandidateCount: number
    filters: {
      commonOnly: boolean
      limit?: number
    }
  }
  items: CurationQueueItem[]
}

export interface CurationQueueOptions {
  targetLang: TargetLanguage
  limit?: number
  commonOnly?: boolean
}

function queueItemId(type: CurationQueueItemType, senseId: string, lang: TargetLanguage): string {
  return `${type}-${senseId}-${lang}`
}

function sourceRefKey(ref: SourceRef): string {
  return `${ref.kind}:${ref.sourceId ?? 'unknown'}`
}

function collectInputRefs(entry: Entry, sense: Sense, glosses: Gloss[]): string[] {
  const refs = new Set<string>()
  refs.add(`entry:${entry.id}`)
  refs.add(`sense:${sense.id}`)

  for (const ref of [...entry.sourceRefs, ...sense.sourceRefs]) refs.add(sourceRefKey(ref))
  for (const gloss of glosses) {
    refs.add(`gloss:${gloss.id}`)
    for (const ref of gloss.sourceRefs) refs.add(sourceRefKey(ref))
  }

  return [...refs].sort()
}

function scoreEntry(entry: Entry, sense: Sense, sourceGlosses: Gloss[]): number {
  let score = 0
  if (entry.ranking.common) score += 100
  if (entry.ranking.priority?.length) score += 20
  if (typeof entry.ranking.frequency === 'number') {
    if (entry.ranking.frequency <= 500) score += 20
    else if (entry.ranking.frequency <= 5000) score += 10
  }
  if (sourceGlosses.some((gloss) => gloss.lang === 'en')) score += 10
  score += Math.min(sourceGlosses.length, 5)
  score -= sense.order
  return score
}

function hasApprovedGloss(gloss: Gloss, lang: TargetLanguage): boolean {
  return gloss.lang === lang && gloss.reviewStatus === 'approved' && Boolean(gloss.text.trim())
}

export function buildCurationQueue(snapshot: CanonicalSnapshot, opts: CurationQueueOptions): CurationQueue {
  const items: CurationQueueItem[] = []

  for (const entry of snapshot.entries) {
    if (opts.commonOnly && !entry.ranking.common) continue

    for (const sense of entry.senses) {
      if (sense.glosses.some((gloss) => hasApprovedGloss(gloss, opts.targetLang))) continue

      const sourceGlosses = sense.glosses.filter((gloss) =>
        gloss.lang !== opts.targetLang && gloss.reviewStatus === 'approved' && Boolean(gloss.text.trim())
      )
      if (sourceGlosses.length === 0) continue

      items.push({
        id: queueItemId('missingGloss', sense.id, opts.targetLang),
        type: 'missingGloss',
        priority: scoreEntry(entry, sense, sourceGlosses),
        targetLang: opts.targetLang,
        entryId: entry.id,
        senseId: sense.id,
        primaryForm: entry.primaryForm,
        primaryReading: entry.primaryReading,
        senseOrder: sense.order,
        partOfSpeech: sense.partOfSpeech,
        reason: `Missing approved ${opts.targetLang} gloss`,
        sourceGlosses: sourceGlosses.map((gloss) => ({
          lang: gloss.lang,
          text: gloss.text,
          sourceType: gloss.sourceType,
        })),
        inputRefs: collectInputRefs(entry, sense, sourceGlosses),
      })
    }
  }

  items.sort((left, right) =>
    right.priority - left.priority
    || left.primaryForm.localeCompare(right.primaryForm)
    || left.senseId.localeCompare(right.senseId)
  )
  const totalCandidateCount = items.length
  const selectedItems = typeof opts.limit === 'number' ? items.slice(0, opts.limit) : items

  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    snapshotGeneratedAt: snapshot.generatedAt,
    targetLang: opts.targetLang,
    summary: {
      itemCount: selectedItems.length,
      totalCandidateCount,
      filters: {
        commonOnly: opts.commonOnly ?? false,
        limit: opts.limit,
      },
    },
    items: selectedItems,
  }
}
