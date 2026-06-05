import { validateYoriId } from './ids'
import type { CanonicalSnapshot, Entry, KanjiCharacter, LookupAlias, SourceRef } from './types'

export interface ValidationIssue {
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

interface ValidationContext {
  formOwners: Map<string, string>
  readingOwners: Map<string, string>
  senseOwners: Map<string, string>
  glossOwners: Map<string, string>
  exampleOwners: Map<string, string>
}

function issue(path: string, message: string): ValidationIssue {
  return { path, message }
}

function hasSourceRefs(sourceRefs: SourceRef[] | undefined): boolean {
  return Array.isArray(sourceRefs) && sourceRefs.length > 0
}

function validateSourceRefs(sourceRefs: SourceRef[] | undefined, path: string, errors: ValidationIssue[]): void {
  if (!hasSourceRefs(sourceRefs)) {
    errors.push(issue(path, 'sourceRefs must contain at least one source'))
    return
  }

  sourceRefs.forEach((source, index) => {
    if (!source.importedAt) {
      errors.push(issue(`${path}[${index}].importedAt`, 'importedAt is required'))
    }
    if (source.kind === 'ai' && !source.model) {
      errors.push(issue(`${path}[${index}].model`, 'AI source refs must include model'))
    }
  })
}

function checkDuplicateId(
  seen: Set<string>,
  id: string,
  path: string,
  message: string,
  errors: ValidationIssue[]
): void {
  if (seen.has(id)) {
    errors.push(issue(path, message))
    return
  }
  seen.add(id)
}

function validateEntry(
  entry: Entry,
  index: number,
  context: ValidationContext,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  const path = `entries[${index}]`
  if (!validateYoriId('entry', entry.id)) errors.push(issue(`${path}.id`, 'invalid entry id'))
  if (entry.language !== 'ja') errors.push(issue(`${path}.language`, 'entry language must be ja'))
  if (!entry.primaryForm.trim()) errors.push(issue(`${path}.primaryForm`, 'primaryForm is required'))
  if (!entry.primaryReading.trim()) errors.push(issue(`${path}.primaryReading`, 'primaryReading is required'))
  if (entry.forms.length === 0) errors.push(issue(`${path}.forms`, 'entry must contain at least one form'))
  if (entry.readings.length === 0) errors.push(issue(`${path}.readings`, 'entry must contain at least one reading'))
  if (entry.senses.length === 0) errors.push(issue(`${path}.senses`, 'entry must contain at least one sense'))
  validateSourceRefs(entry.sourceRefs, `${path}.sourceRefs`, errors)

  const formIds = new Set(entry.forms.map((form) => form.id))
  const readingIds = new Set(entry.readings.map((reading) => reading.id))
  const localFormIds = new Set<string>()
  const localReadingIds = new Set<string>()
  const localSenseIds = new Set<string>()
  const localGlossIds = new Set<string>()
  const localExampleIds = new Set<string>()

  entry.forms.forEach((form, formIndex) => {
    const formPath = `${path}.forms[${formIndex}]`
    if (!validateYoriId('form', form.id)) errors.push(issue(`${formPath}.id`, 'invalid form id'))
    checkDuplicateId(localFormIds, form.id, `${formPath}.id`, `duplicate form id in entry: ${form.id}`, errors)
    const owner = context.formOwners.get(form.id)
    if (owner && owner !== entry.id) errors.push(issue(`${formPath}.id`, `form id also belongs to entry: ${owner}`))
    context.formOwners.set(form.id, entry.id)
    if (!form.text.trim()) errors.push(issue(`${formPath}.text`, 'form text is required'))
    validateSourceRefs(form.sourceRefs, `${formPath}.sourceRefs`, errors)
  })

  entry.readings.forEach((reading, readingIndex) => {
    const readingPath = `${path}.readings[${readingIndex}]`
    if (!validateYoriId('reading', reading.id)) errors.push(issue(`${readingPath}.id`, 'invalid reading id'))
    checkDuplicateId(localReadingIds, reading.id, `${readingPath}.id`, `duplicate reading id in entry: ${reading.id}`, errors)
    const owner = context.readingOwners.get(reading.id)
    if (owner && owner !== entry.id) errors.push(issue(`${readingPath}.id`, `reading id also belongs to entry: ${owner}`))
    context.readingOwners.set(reading.id, entry.id)
    if (!reading.text.trim()) errors.push(issue(`${readingPath}.text`, 'reading text is required'))
    if (reading.appliesToFormIds !== 'all') {
      for (const formId of reading.appliesToFormIds) {
        if (!formIds.has(formId)) errors.push(issue(`${readingPath}.appliesToFormIds`, `unknown form id: ${formId}`))
      }
    }
    validateSourceRefs(reading.sourceRefs, `${readingPath}.sourceRefs`, errors)
  })

  entry.senses.forEach((sense, senseIndex) => {
    const sensePath = `${path}.senses[${senseIndex}]`
    if (!validateYoriId('sense', sense.id)) errors.push(issue(`${sensePath}.id`, 'invalid sense id'))
    checkDuplicateId(localSenseIds, sense.id, `${sensePath}.id`, `duplicate sense id in entry: ${sense.id}`, errors)
    const senseOwner = context.senseOwners.get(sense.id)
    if (senseOwner && senseOwner !== entry.id) errors.push(issue(`${sensePath}.id`, `sense id also belongs to entry: ${senseOwner}`))
    context.senseOwners.set(sense.id, entry.id)
    if (sense.entryId !== entry.id) errors.push(issue(`${sensePath}.entryId`, 'sense entryId must match parent entry id'))
    if (sense.partOfSpeech.length === 0) warnings.push(issue(`${sensePath}.partOfSpeech`, 'sense has no part of speech'))
    if (sense.appliesToFormIds !== 'all') {
      for (const formId of sense.appliesToFormIds) {
        if (!formIds.has(formId)) errors.push(issue(`${sensePath}.appliesToFormIds`, `unknown form id: ${formId}`))
      }
    }
    if (sense.appliesToReadingIds !== 'all') {
      for (const readingId of sense.appliesToReadingIds) {
        if (!readingIds.has(readingId)) errors.push(issue(`${sensePath}.appliesToReadingIds`, `unknown reading id: ${readingId}`))
      }
    }
    if (sense.glosses.length === 0) warnings.push(issue(`${sensePath}.glosses`, 'sense has no glosses'))
    validateSourceRefs(sense.sourceRefs, `${sensePath}.sourceRefs`, errors)

    sense.glosses.forEach((gloss, glossIndex) => {
      const glossPath = `${sensePath}.glosses[${glossIndex}]`
      if (!validateYoriId('gloss', gloss.id)) errors.push(issue(`${glossPath}.id`, 'invalid gloss id'))
      checkDuplicateId(localGlossIds, gloss.id, `${glossPath}.id`, `duplicate gloss id in entry: ${gloss.id}`, errors)
      const glossOwner = context.glossOwners.get(gloss.id)
      if (glossOwner && glossOwner !== entry.id) errors.push(issue(`${glossPath}.id`, `gloss id also belongs to entry: ${glossOwner}`))
      context.glossOwners.set(gloss.id, entry.id)
      if (gloss.senseId !== sense.id) errors.push(issue(`${glossPath}.senseId`, 'gloss senseId must match parent sense id'))
      if (!gloss.text.trim()) errors.push(issue(`${glossPath}.text`, 'gloss text is required'))
      if (gloss.sourceType === 'ai' && gloss.reviewStatus === 'approved') {
        warnings.push(issue(`${glossPath}.reviewStatus`, 'approved AI gloss should be traceable to reviewer metadata later'))
      }
      validateSourceRefs(gloss.sourceRefs, `${glossPath}.sourceRefs`, errors)
    })

    sense.examples.forEach((example, exampleIndex) => {
      const examplePath = `${sensePath}.examples[${exampleIndex}]`
      if (!validateYoriId('example', example.id)) errors.push(issue(`${examplePath}.id`, 'invalid example id'))
      checkDuplicateId(localExampleIds, example.id, `${examplePath}.id`, `duplicate example id in entry: ${example.id}`, errors)
      const exampleOwner = context.exampleOwners.get(example.id)
      if (exampleOwner && exampleOwner !== entry.id) errors.push(issue(`${examplePath}.id`, `example id also belongs to entry: ${exampleOwner}`))
      context.exampleOwners.set(example.id, entry.id)
      if (example.senseId !== sense.id) errors.push(issue(`${examplePath}.senseId`, 'example senseId must match parent sense id'))
      if (!example.japanese.trim()) errors.push(issue(`${examplePath}.japanese`, 'japanese example is required'))
      if (!example.translation.trim()) errors.push(issue(`${examplePath}.translation`, 'example translation is required'))
      validateSourceRefs(example.sourceRefs, `${examplePath}.sourceRefs`, errors)
    })
  })
}

function validateAlias(
  alias: LookupAlias,
  index: number,
  entryIds: Set<string>,
  context: ValidationContext,
  errors: ValidationIssue[]
): void {
  const path = `lookupAliases[${index}]`
  if (!validateYoriId('alias', alias.id)) errors.push(issue(`${path}.id`, 'invalid alias id'))
  if (!alias.surface.trim()) errors.push(issue(`${path}.surface`, 'surface is required'))
  if (!alias.normalizedSurface.trim()) errors.push(issue(`${path}.normalizedSurface`, 'normalizedSurface is required'))
  if (!entryIds.has(alias.entryId)) errors.push(issue(`${path}.entryId`, `unknown entry id: ${alias.entryId}`))
  if (alias.formId) {
    const owner = context.formOwners.get(alias.formId)
    if (!owner) errors.push(issue(`${path}.formId`, `unknown form id: ${alias.formId}`))
    if (owner && owner !== alias.entryId) errors.push(issue(`${path}.formId`, `form id belongs to entry: ${owner}`))
  }
  if (alias.readingId) {
    const owner = context.readingOwners.get(alias.readingId)
    if (!owner) errors.push(issue(`${path}.readingId`, `unknown reading id: ${alias.readingId}`))
    if (owner && owner !== alias.entryId) errors.push(issue(`${path}.readingId`, `reading id belongs to entry: ${owner}`))
  }
  if (!Number.isFinite(alias.score)) errors.push(issue(`${path}.score`, 'score must be finite'))
}

function validateKanjiCharacter(
  kanji: KanjiCharacter,
  index: number,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  const path = `kanjiCharacters[${index}]`
  if (!validateYoriId('kanji', kanji.id)) errors.push(issue(`${path}.id`, 'invalid kanji id'))
  if (!/^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]$/.test(kanji.literal)) {
    errors.push(issue(`${path}.literal`, 'literal must be exactly one kanji character'))
  }
  if (kanji.meanings.length === 0) warnings.push(issue(`${path}.meanings`, 'kanji has no meanings'))
  if (kanji.readings.length === 0) warnings.push(issue(`${path}.readings`, 'kanji has no readings'))
  validateSourceRefs(kanji.sourceRefs, `${path}.sourceRefs`, errors)

  kanji.meanings.forEach((meaning, meaningIndex) => {
    const meaningPath = `${path}.meanings[${meaningIndex}]`
    if (!meaning.text.trim()) errors.push(issue(`${meaningPath}.text`, 'meaning text is required'))
    validateSourceRefs(meaning.sourceRefs, `${meaningPath}.sourceRefs`, errors)
  })

  kanji.readings.forEach((reading, readingIndex) => {
    const readingPath = `${path}.readings[${readingIndex}]`
    if (!reading.text.trim()) errors.push(issue(`${readingPath}.text`, 'reading text is required'))
    validateSourceRefs(reading.sourceRefs, `${readingPath}.sourceRefs`, errors)
  })
}

export function validateCanonicalSnapshot(snapshot: CanonicalSnapshot): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  if (snapshot.schemaVersion !== '1.0.0') {
    errors.push(issue('schemaVersion', 'schemaVersion must be 1.0.0'))
  }
  if (!snapshot.generatedAt) errors.push(issue('generatedAt', 'generatedAt is required'))

  const entryIds = new Set<string>()
  const aliasIds = new Set<string>()
  const context: ValidationContext = {
    formOwners: new Map(),
    readingOwners: new Map(),
    senseOwners: new Map(),
    glossOwners: new Map(),
    exampleOwners: new Map(),
  }
  snapshot.entries.forEach((entry, index) => {
    if (entryIds.has(entry.id)) errors.push(issue(`entries[${index}].id`, `duplicate entry id: ${entry.id}`))
    entryIds.add(entry.id)
    validateEntry(entry, index, context, errors, warnings)
  })

  const aliasKeys = new Set<string>()
  snapshot.lookupAliases.forEach((alias, index) => {
    checkDuplicateId(aliasIds, alias.id, `lookupAliases[${index}].id`, `duplicate alias id: ${alias.id}`, errors)
    const key = `${alias.normalizedSurface}\u0000${alias.normalizedReading ?? ''}\u0000${alias.entryId}`
    if (aliasKeys.has(key)) {
      errors.push(issue(`lookupAliases[${index}]`, 'duplicate lookup alias for entry'))
    }
    aliasKeys.add(key)
    validateAlias(alias, index, entryIds, context, errors)
  })

  const kanjiLiterals = new Set<string>()
  for (const [index, kanji] of (snapshot.kanjiCharacters ?? []).entries()) {
    if (kanjiLiterals.has(kanji.literal)) {
      errors.push(issue(`kanjiCharacters[${index}].literal`, `duplicate kanji literal: ${kanji.literal}`))
    }
    kanjiLiterals.add(kanji.literal)
    validateKanjiCharacter(kanji, index, errors, warnings)
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}
