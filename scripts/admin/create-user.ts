#!/usr/bin/env bun
import { createInterface } from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import { initUpdatesDatabase } from '../../src/storage'
import { closeDb } from '../../src/db'
import { createAdminUser, findAdminUserByEmail } from '../../src/admin/users'

async function prompt(rl: ReturnType<typeof createInterface>, label: string, hidden = false): Promise<string> {
  if (!hidden) return (await rl.question(label)).trim()

  return new Promise<string>((resolve) => {
    process.stdout.write(label)
    const stdinAny = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }
    const wasRaw = (stdinAny as { isRaw?: boolean }).isRaw ?? false
    stdinAny.setRawMode?.(true)
    stdinAny.resume()
    let buffer = ''
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          stdinAny.setRawMode?.(wasRaw)
          stdinAny.off('data', onData)
          stdinAny.pause()
          process.stdout.write('\n')
          resolve(buffer)
          return
        }
        if (ch === '') {
          process.exit(130)
        }
        if (ch === '' || ch === '\b') {
          buffer = buffer.slice(0, -1)
          continue
        }
        buffer += ch
      }
    }
    stdinAny.on('data', onData)
  })
}

async function main(): Promise<void> {
  const updatesDbPath = process.env.UPDATES_DATABASE_PATH
  if (!updatesDbPath) {
    console.error('UPDATES_DATABASE_PATH is not set. Set it (or rely on the default in storage.ts) before running.')
  }
  initUpdatesDatabase(updatesDbPath)

  const rl = createInterface({ input, output })
  try {
    const email = await prompt(rl, 'Email: ')
    if (!email) throw new Error('Email is required')

    if (findAdminUserByEmail(email)) {
      throw new Error(`Admin user already exists: ${email}`)
    }

    const password = await prompt(rl, 'Password (min 12 chars): ', true)
    const confirm = await prompt(rl, 'Confirm password: ', true)
    if (password !== confirm) throw new Error('Passwords do not match')

    const user = await createAdminUser(email, password)
    console.log(`\n✓ Admin user created: ${user.email} (id ${user.id})`)
  } finally {
    rl.close()
    closeDb()
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
