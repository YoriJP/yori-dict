import { existsSync } from 'fs'
import {
  getReleaseDbPath,
  getReleaseManifestPath,
  readReleaseManifest,
  writeCurrentReleasePointer,
} from '../../src/storage'

interface ActivateOptions {
  version: string
}

function parseArgs(args: string[]): ActivateOptions {
  let version: string | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--version' && next) {
      version = next
      i++
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!version) {
    throw new Error('Missing required --version')
  }

  return { version }
}

function printHelp(): void {
  console.log(`
Activate an existing release.

Usage:
  bun run release:activate --version <version>
`)
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  const dbPath = getReleaseDbPath(options.version)
  const manifestPath = getReleaseManifestPath(options.version)

  if (!existsSync(dbPath)) {
    throw new Error(`Release DB not found: ${dbPath}`)
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`Release manifest not found: ${manifestPath}`)
  }

  readReleaseManifest(manifestPath)
  writeCurrentReleasePointer({
    version: options.version,
    dbPath,
    manifestPath,
    activatedAt: new Date().toISOString(),
  })

  console.log(`Activated release: ${options.version}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Release activation failed:', error)
    process.exit(1)
  })
}

