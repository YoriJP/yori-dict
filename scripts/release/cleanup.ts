import { readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { getReleasesDir, readCurrentReleasePointer, readReleaseManifest, getReleaseManifestPath } from '../../src/storage'

interface CleanupOptions {
  keep: number
  dryRun: boolean
}

function parseArgs(args: string[]): CleanupOptions {
  let keep = 3
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--keep' && next) {
      keep = Number.parseInt(next, 10)
      if (!Number.isFinite(keep) || keep < 0) {
        console.error('--keep must be a non-negative integer')
        process.exit(1)
      }
      i++
    } else if (arg === '--dry-run') {
      dryRun = true
    }
  }

  return { keep, dryRun }
}

interface ReleaseEntry {
  version: string
  builtAt: Date
  path: string
}

function listReleases(): ReleaseEntry[] {
  const releasesDir = getReleasesDir()
  let entries: string[]
  try {
    entries = readdirSync(releasesDir)
  } catch {
    return []
  }

  const releases: ReleaseEntry[] = []
  for (const entry of entries) {
    const fullPath = join(releasesDir, entry)
    try {
      const stat = statSync(fullPath)
      if (!stat.isDirectory()) continue
    } catch {
      continue
    }

    const manifestPath = getReleaseManifestPath(entry)
    try {
      const manifest = readReleaseManifest(manifestPath)
      releases.push({
        version: entry,
        builtAt: new Date(manifest.builtAt),
        path: fullPath,
      })
    } catch {
      releases.push({
        version: entry,
        builtAt: new Date(0),
        path: fullPath,
      })
    }
  }

  releases.sort((a, b) => b.builtAt.getTime() - a.builtAt.getTime())
  return releases
}

const options = parseArgs(process.argv.slice(2))
const activePointer = readCurrentReleasePointer()
const activeVersion = activePointer?.version ?? null
const releases = listReleases()

const kept: string[] = []
const removed: string[] = []

for (const release of releases) {
  if (release.version === activeVersion) {
    kept.push(release.version)
    continue
  }

  if (kept.length < options.keep + (activeVersion ? 1 : 0)) {
    kept.push(release.version)
  } else {
    removed.push(release.version)
  }
}

console.log(`Active: ${activeVersion ?? 'none'}`)
console.log(`Total:  ${releases.length}`)
console.log(`Keep:   ${kept.length} (active + ${options.keep} most recent)`)
console.log(`Remove: ${removed.length}`)

if (removed.length === 0) {
  console.log('\nNothing to clean up.')
  process.exit(0)
}

console.log('')
for (const version of removed) {
  const release = releases.find((r) => r.version === version)!
  if (options.dryRun) {
    console.log(`  would remove: ${version}`)
  } else {
    rmSync(release.path, { recursive: true, force: true })
    console.log(`  removed: ${version}`)
  }
}

if (options.dryRun) {
  console.log('\nDry run — no files were deleted. Run without --dry-run to apply.')
}
