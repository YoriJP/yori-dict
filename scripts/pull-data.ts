/**
 * Materialize Git LFS dictionary JSON files.
 *
 * Usage:
 *   bun run data:pull
 *   bun run data:pull --lang en,de
 */

import { existsSync, readdirSync } from 'fs'

const DATA_DIR = './data'
const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1'

function printHelp(): void {
  console.log(`
Materialize dictionary JSON files from Git LFS

Usage:
  bun run data:pull [--lang <langs>]

Options:
  --lang    Comma-separated language codes to pull (e.g. en,de)
            Default: all data/*.json files currently present
`)
}

function parseLangs(argv: string[]): string[] | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang' && argv[i + 1]) {
      return argv[i + 1]
        .split(',')
        .map((lang) => lang.trim())
        .filter((lang) => lang.length > 0)
    }
  }
  return null
}

function getKnownLanguageFiles(): string[] {
  if (!existsSync(DATA_DIR)) return []

  return readdirSync(DATA_DIR)
    .filter((file) => file.endsWith('.json') && !file.includes('/'))
    .map((file) => `${DATA_DIR}/${file}`)
}

function resolveTargets(langs: string[] | null): string[] {
  if (langs && langs.length > 0) {
    return langs.map((lang) => `${DATA_DIR}/${lang}.json`)
  }

  return getKnownLanguageFiles()
}

async function isLfsPointer(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  const header = await Bun.file(path).slice(0, LFS_POINTER_HEADER.length + 8).text()
  return header.startsWith(LFS_POINTER_HEADER)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }

  const langs = parseLangs(args)
  const targets = resolveTargets(langs)

  if (targets.length === 0) {
    console.error('No JSON files found under data/.')
    console.error('Run "bun run import:jmdict --lang en" first, then retry.')
    process.exit(1)
  }

  const include = targets.join(',')
  console.log(`Pulling Git LFS objects for: ${include}`)

  const proc = Bun.spawn(['git', 'lfs', 'pull', `--include=${include}`], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    console.error('\nGit LFS pull failed.')
    console.error('Ensure git-lfs is installed, then run: git lfs install')
    process.exit(exitCode)
  }

  const unresolved: string[] = []
  for (const path of targets) {
    if (!existsSync(path)) {
      unresolved.push(`${path} (missing)`)
      continue
    }
    if (await isLfsPointer(path)) {
      unresolved.push(`${path} (still LFS pointer)`)
    }
  }

  if (unresolved.length > 0) {
    console.error('\nSome files were not materialized:')
    for (const item of unresolved) {
      console.error(`  - ${item}`)
    }
    process.exit(1)
  }

  console.log('\nDone. Dictionary JSON files are ready for build.')
  console.log('Next step: bun run build:db')
}

main().catch((err) => {
  console.error('Failed to materialize data files:', err)
  process.exit(1)
})
