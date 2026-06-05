import { existsSync } from 'fs'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import type { CanonicalSnapshot } from '../../src/domain/types'

function printHelp(): void {
  console.log(`
Yori canonical snapshot validator

Usage:
  bun run validate:snapshot <snapshot.json> [--fail-on-warnings]
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }

  const snapshotPath = args.find((arg) => !arg.startsWith('--'))
  const failOnWarnings = args.includes('--fail-on-warnings')

  if (!snapshotPath) {
    printHelp()
    process.exit(1)
  }

  if (!existsSync(snapshotPath)) {
    console.error(`Snapshot not found: ${snapshotPath}`)
    process.exit(1)
  }

  const snapshot = await Bun.file(snapshotPath).json() as CanonicalSnapshot
  const result = validateCanonicalSnapshot(snapshot)

  console.log(`\n=== Yori Snapshot Validation: ${snapshotPath} ===`)
  console.log(`Entries: ${snapshot.entries.length.toLocaleString()}`)
  console.log(`Lookup aliases: ${snapshot.lookupAliases.length.toLocaleString()}`)
  console.log(`Errors: ${result.errors.length.toLocaleString()}`)
  console.log(`Warnings: ${result.warnings.length.toLocaleString()}`)

  if (result.errors.length > 0) {
    console.log('\nErrors:')
    for (const error of result.errors.slice(0, 50)) {
      console.log(`  - ${error.path}: ${error.message}`)
    }
    if (result.errors.length > 50) {
      console.log(`  ... ${result.errors.length - 50} more`)
    }
  }

  if (result.warnings.length > 0) {
    console.log('\nWarnings:')
    for (const warning of result.warnings.slice(0, 50)) {
      console.log(`  - ${warning.path}: ${warning.message}`)
    }
    if (result.warnings.length > 50) {
      console.log(`  ... ${result.warnings.length - 50} more`)
    }
  }

  const shouldFail = result.errors.length > 0 || (failOnWarnings && result.warnings.length > 0)
  console.log(`\nResult: ${shouldFail ? 'FAIL' : 'PASS'}`)
  if (shouldFail) process.exit(1)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
