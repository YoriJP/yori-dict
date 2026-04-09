import { main as buildRelease } from './release/build'

async function main(): Promise<void> {
  console.log('`build:db` now builds and activates a new immutable release.')
  await buildRelease(['--activate'])
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Build failed:', error)
    process.exit(1)
  })
}

