import { promoteRelease } from '../../src/release-service'

interface PromoteOptions {
  version: string | null
  activate: boolean
}

function parseArgs(args: string[]): PromoteOptions {
  const options: PromoteOptions = {
    version: null,
    activate: true,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--version' && next) {
      options.version = next
      i++
    } else if (arg === '--no-activate') {
      options.activate = false
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
Promote active updates into a new immutable release.

Usage:
  bun run release:promote [--version <version>] [--no-activate]
`)
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  const result = promoteRelease({
    version: options.version,
    activate: options.activate,
  })

  console.log(`Promoted release: ${result.version}`)
  console.log(`Release DB: ${result.dbPath}`)
  if (result.activated) {
    console.log('Release activated.')
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Release promote failed:', error)
    process.exit(1)
  })
}
