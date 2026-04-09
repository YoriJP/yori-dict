import { buildRelease } from '../../src/release-service'

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

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  const result = await buildRelease({
    version: options.version,
    activate: options.activate,
  })

  console.log(`Building release: ${result.version}`)
  console.log(`Release DB: ${result.dbPath}`)
  console.log(`Manifest: ${result.manifestPath}`)
  console.log(result.activated ? `Activated release: ${result.version}` : 'Release built but not activated.')
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Release build failed:', error)
    process.exit(1)
  })
}
