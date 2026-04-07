import { existsSync } from 'fs'
import {
  buildReleaseVersion,
  computeFingerprintForFiles,
  getReleaseDbPath,
  getReleaseManifestPath,
  writeCurrentReleasePointer,
  writeReleaseManifest,
  type CurrentReleasePointer,
} from '../../src/storage'
import { loadSnapshotFromJson, writeReleaseSnapshotToDb } from './lib'

const DATA_DIR = './data'
const CORE_PATH = `${DATA_DIR}/core.json`
const LANG_DIR = `${DATA_DIR}/lang`

interface BuildOptions {
  version: string | null
  activate: boolean
}

function parseArgs(args: string[]): BuildOptions {
  const options: BuildOptions = {
    version: null,
    activate: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--version' && next) {
      options.version = next
      i++
    } else if (arg === '--activate') {
      options.activate = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function printHelp(): void {
  console.log(`
Build an immutable release database from JSON snapshots.

Usage:
  bun run release:build [--version <version>] [--activate]

Options:
  --version <version>  Explicit release version. Default: timestamp + fingerprint prefix
  --activate           Update releases/current.json to point at the new release
`)
}

function collectFingerprintFiles(): string[] {
  const files: string[] = []
  if (existsSync(CORE_PATH)) files.push(CORE_PATH)
  if (existsSync(LANG_DIR)) {
    for (const lang of ['en', 'de', 'ko', 'zh-cn', 'zh-tw']) {
      const path = `${LANG_DIR}/${lang}.json`
      if (existsSync(path)) files.push(path)
    }
  }
  return files
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  const snapshot = await loadSnapshotFromJson()

  const fingerprintFiles = collectFingerprintFiles()
  const fingerprint = computeFingerprintForFiles(fingerprintFiles)
  const version = options.version || buildReleaseVersion(new Date(), fingerprint)
  const dbPath = getReleaseDbPath(version)
  const manifestPath = getReleaseManifestPath(version)

  console.log(`Building release: ${version}`)
  writeReleaseSnapshotToDb(dbPath, snapshot)

  writeReleaseManifest(version, {
    version,
    builtAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    baseSourceFingerprint: fingerprint,
    releaseDbPath: dbPath,
    promotedFromUpdateSequence: null,
  })

  console.log(`Release DB: ${dbPath}`)
  console.log(`Manifest: ${manifestPath}`)

  if (options.activate) {
    const pointer: CurrentReleasePointer = {
      version,
      dbPath,
      manifestPath,
      activatedAt: new Date().toISOString(),
    }
    writeCurrentReleasePointer(pointer)
    console.log(`Activated release: ${version}`)
  } else {
    console.log('Release built but not activated.')
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Release build failed:', error)
    process.exit(1)
  })
}

