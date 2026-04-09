import { activateRelease } from '../../src/release-service'

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
  const result = activateRelease(options.version)
  console.log(`Activated release: ${result.version}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Release activation failed:', error)
    process.exit(1)
  })
}
