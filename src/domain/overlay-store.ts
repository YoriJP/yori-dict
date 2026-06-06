import { existsSync, mkdirSync, renameSync } from 'fs'
import { dirname } from 'path'
import {
  validateCanonicalOverlayFile,
  type CanonicalOverlayFile,
  type CanonicalOverlayOperation,
} from './overlays'

const SCHEMA_VERSION = '1.0.0'
const MAX_ERROR_DETAILS = 5

function emptyOverlayFile(): CanonicalOverlayFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    operations: [],
  }
}

function formatErrors(errors: Array<{ path: string; message: string }>): string {
  return errors
    .slice(0, MAX_ERROR_DETAILS)
    .map((error) => `${error.path}: ${error.message}`)
    .join('; ')
}

function assertValidOverlayFile(file: CanonicalOverlayFile): void {
  const result = validateCanonicalOverlayFile(file)
  if (!result.valid) {
    throw new Error(`Canonical overlay file is invalid: ${formatErrors(result.errors)}`)
  }
}

function assertUniqueOperationId(file: CanonicalOverlayFile, id: string): void {
  if (file.operations.some((operation) => operation.id === id)) {
    throw new Error(`Overlay operation already exists: ${id}`)
  }
}

export async function loadCanonicalOverlayFile(path: string): Promise<CanonicalOverlayFile> {
  if (!existsSync(path)) return emptyOverlayFile()

  const file = await Bun.file(path).json() as CanonicalOverlayFile
  assertValidOverlayFile(file)
  return file
}

export async function saveCanonicalOverlayFile(path: string, file: CanonicalOverlayFile): Promise<void> {
  assertValidOverlayFile(file)
  mkdirSync(dirname(path), { recursive: true })

  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
  await Bun.write(tempPath, JSON.stringify(file, null, 2) + '\n')
  renameSync(tempPath, path)
}

export async function appendCanonicalOverlayOperation(
  path: string,
  operation: CanonicalOverlayOperation
): Promise<CanonicalOverlayFile> {
  const file = await loadCanonicalOverlayFile(path)
  assertUniqueOperationId(file, operation.id)
  const next: CanonicalOverlayFile = {
    ...file,
    operations: [...file.operations, operation],
  }
  await saveCanonicalOverlayFile(path, next)
  return next
}

export async function updateCanonicalOverlayOperation(
  path: string,
  id: string,
  update: (operation: CanonicalOverlayOperation) => CanonicalOverlayOperation
): Promise<CanonicalOverlayOperation> {
  const file = await loadCanonicalOverlayFile(path)
  const index = file.operations.findIndex((operation) => operation.id === id)
  if (index < 0) throw new Error(`Overlay operation not found: ${id}`)

  const operation = update(file.operations[index])
  const nextOperations = [...file.operations]
  nextOperations[index] = operation

  const next: CanonicalOverlayFile = {
    ...file,
    operations: nextOperations,
  }
  await saveCanonicalOverlayFile(path, next)
  return operation
}

export function listPendingAiOverlayOperations(file: CanonicalOverlayFile): CanonicalOverlayOperation[] {
  return file.operations.filter((operation) =>
    operation.sourceKind === 'ai' && operation.reviewStatus === 'unreviewed'
  )
}
