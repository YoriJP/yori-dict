import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const script = join(import.meta.dir, '..', 'scripts', 'dev', 'create-claude-review-bundle.ts')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function git(directory: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: directory, stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr))
  }
}

function createRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'yori-review-bundle-'))
  temporaryDirectories.push(directory)
  git(directory, ['init', '--quiet'])
  git(directory, ['config', 'user.name', 'Review Test'])
  git(directory, ['config', 'user.email', 'review@example.invalid'])
  writeFileSync(join(directory, 'kept.txt'), 'keep\n')
  writeFileSync(join(directory, 'deleted.txt'), 'delete me\n')
  git(directory, ['add', 'kept.txt', 'deleted.txt'])
  git(directory, ['commit', '--quiet', '-m', 'initial'])
  return directory
}

function run(directory: string, args: string[] = []): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(['bun', 'run', script, ...args], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

test('fails when the base ref cannot be resolved', () => {
  const directory = createRepository()
  const result = run(directory, ['--base=refs/heads/missing', '--run-id=missing-base'])

  expect(result.exitCode).not.toBe(0)
  expect(new TextDecoder().decode(result.stderr)).toContain('Base ref refs/heads/missing failed')
})

test('includes deleted files in the changed-file list and patch', () => {
  const directory = createRepository()
  rmSync(join(directory, 'deleted.txt'))

  const result = run(directory, ['--base=HEAD', '--run-id=deleted-file'])

  expect(result.exitCode).toBe(0)
  expect(
    readFileSync(
      join(directory, '.claude', 'review-runs', 'deleted-file', 'changed-files.txt'),
      'utf8',
    ),
  ).toContain('deleted.txt')
  expect(
    readFileSync(join(directory, '.claude', 'review-runs', 'deleted-file', 'diff.patch'), 'utf8'),
  ).toContain('deleted file mode')
})

test('rejects run IDs that escape the review directory', () => {
  const directory = createRepository()
  const result = run(directory, ['--base=HEAD', '--run-id=../../escaped'])

  expect(result.exitCode).not.toBe(0)
  expect(new TextDecoder().decode(result.stderr)).toContain('Invalid --run-id')
})

test('keeps safe mode and stderr logging in the generated command', () => {
  const directory = createRepository()
  const result = run(directory, ['--base=HEAD', '--run-id=safe-run', '--print-command'])

  expect(result.exitCode).toBe(0)
  const command = readFileSync(
    join(directory, '.claude', 'review-runs', 'safe-run', 'run-claude-review.sh'),
    'utf8',
  )
  expect(command).toContain('"--safe-mode"')
  expect(command).toContain('2> ".claude/review-runs/safe-run/claude.stderr.log"')
})

test('rejects bare mode', () => {
  const directory = createRepository()
  const result = run(directory, ['--base=HEAD', '--run-id=bare-run', '--bare'])

  expect(result.exitCode).not.toBe(0)
  expect(new TextDecoder().decode(result.stderr)).toContain('--bare option is not supported')
})
