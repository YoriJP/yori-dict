import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { createEmptyIdRegistry, type IdRegistry } from './ids'

export async function loadIdRegistry(path: string): Promise<IdRegistry> {
  if (!existsSync(path)) return createEmptyIdRegistry()

  const registry = await Bun.file(path).json() as IdRegistry
  if (registry.schemaVersion !== '1.0.0') {
    throw new Error(`Unsupported ID registry schemaVersion: ${registry.schemaVersion}`)
  }
  registry.next.kanjis ??= 1
  registry.kanjis ??= {}
  return registry
}

export async function saveIdRegistry(path: string, registry: IdRegistry): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(registry, null, 2) + '\n')
}
