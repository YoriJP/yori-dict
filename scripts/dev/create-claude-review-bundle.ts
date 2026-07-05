import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

type CmdResult = {
  stdout: string
  stderr: string
  status: number | null
}

const textFilePattern =
  /\.(ts|tsx|js|jsx|json|md|ya?ml|toml|txt|css|html|sql|graphql|gql|mjs|cjs)$/i

const defaultExcludedPrefixes = [
  'data/',
  'sdk/',
  'node_modules/',
  'dist/',
  'releases/',
  'reports/',
  '.codex/',
  '.claude/review-runs/',
]

const defaultExcludedFiles = new Set(['bun.lock'])

const args = new Set(process.argv.slice(2))

function argValue(name: string, fallback: string): string {
  const prefix = `${name}=`
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

const baseRef = argValue('--base', 'origin/main')
const model = argValue('--model', 'sonnet')
const effort = argValue('--effort', 'low')
const tools = argValue('--tools', '')
const maxTurns = argValue('--max-turns', '3')
const maxBudgetUsd = argValue('--max-budget-usd', '1.00')
const includeData = args.has('--include-data')
const runClaude = args.has('--run')
const printCommand = args.has('--print-command') || runClaude
const bareMode = args.has('--bare')
const maxPatchBytes = Number(argValue('--max-patch-bytes', '700000'))
const maxUntrackedFileBytes = Number(argValue('--max-untracked-file-bytes', '80000'))
const maxUntrackedMarkdownBytes = Number(argValue('--max-untracked-markdown-bytes', '3000'))
const maxUntrackedTotalBytes = Number(argValue('--max-untracked-total-bytes', '40000'))

const runId =
  argValue('--run-id', new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z'))
const outputDir = join('.claude', 'review-runs', runId)

function sh(cmd: string, commandArgs: string[]): CmdResult {
  const result = Bun.spawnSync([cmd, ...commandArgs], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    status: result.exitCode,
  }
}

function git(args: string[]): CmdResult {
  return sh('git', args)
}

function commandExists(name: string): boolean {
  const result = sh('which', [name])
  return result.status === 0
}

function lines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function shouldExclude(path: string): boolean {
  if (includeData && path.startsWith('data/')) return false
  if (defaultExcludedFiles.has(path)) return true
  return defaultExcludedPrefixes.some((prefix) => path.startsWith(prefix))
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function gitPathArgs(paths: string[]): string[] {
  return paths.length > 0 ? ['--', ...paths] : ['--']
}

function truncate(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.length <= maxBytes) return text
  return `${new TextDecoder().decode(encoded.slice(0, maxBytes))}\n\n[truncated at ${maxBytes} bytes]\n`
}

function maxBytesForUntracked(path: string): number {
  return path.endsWith('.md') ? maxUntrackedMarkdownBytes : maxUntrackedFileBytes
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function hasBase(ref: string): boolean {
  return git(['rev-parse', '--verify', ref]).status === 0
}

const baseAvailable = hasBase(baseRef)
const branch = git(['branch', '--show-current']).stdout.trim() || '(detached)'
const head = git(['rev-parse', '--short', 'HEAD']).stdout.trim()
const claudeVersion = sh('claude', ['--version']).stdout.trim() || '(not found)'

const committedChanged = baseAvailable
  ? lines(git(['diff', '--name-only', '--diff-filter=ACMRTUB', `${baseRef}...HEAD`]).stdout)
  : []
const stagedChanged = lines(git(['diff', '--cached', '--name-only', '--diff-filter=ACMRTUB']).stdout)
const unstagedChanged = lines(git(['diff', '--name-only', '--diff-filter=ACMRTUB']).stdout)
const untrackedChanged = lines(git(['ls-files', '--others', '--exclude-standard']).stdout)

const includedFiles = uniqueSorted(
  [...committedChanged, ...stagedChanged, ...unstagedChanged, ...untrackedChanged].filter(
    (path) => !shouldExclude(path),
  ),
)
const excludedFiles = uniqueSorted(
  [...committedChanged, ...stagedChanged, ...unstagedChanged, ...untrackedChanged].filter(shouldExclude),
)

mkdirSync(outputDir, { recursive: true })

const status = git(['status', '--short', '--branch']).stdout
write(join(outputDir, 'status.txt'), status)
write(join(outputDir, 'changed-files.txt'), `${includedFiles.join('\n')}\n`)
write(join(outputDir, 'excluded-files.txt'), `${excludedFiles.join('\n')}\n`)

const committedDiffstat =
  baseAvailable && includedFiles.length > 0
    ? git(['diff', '--stat', `${baseRef}...HEAD`, ...gitPathArgs(includedFiles)]).stdout
    : ''
const stagedDiffstat =
  includedFiles.length > 0 ? git(['diff', '--cached', '--stat', ...gitPathArgs(includedFiles)]).stdout : ''
const unstagedDiffstat =
  includedFiles.length > 0 ? git(['diff', '--stat', ...gitPathArgs(includedFiles)]).stdout : ''

write(
  join(outputDir, 'diffstat.txt'),
  [
    '# Committed branch diffstat',
    committedDiffstat || '(none)',
    '# Staged diffstat',
    stagedDiffstat || '(none)',
    '# Unstaged diffstat',
    unstagedDiffstat || '(none)',
  ].join('\n\n'),
)

const committedPatch =
  baseAvailable && includedFiles.length > 0
    ? git(['diff', '--no-ext-diff', '--find-renames', `${baseRef}...HEAD`, ...gitPathArgs(includedFiles)]).stdout
    : ''
const stagedPatch =
  includedFiles.length > 0
    ? git(['diff', '--cached', '--no-ext-diff', '--find-renames', ...gitPathArgs(includedFiles)]).stdout
    : ''
const unstagedPatch =
  includedFiles.length > 0
    ? git(['diff', '--no-ext-diff', '--find-renames', ...gitPathArgs(includedFiles)]).stdout
    : ''

const patch = truncate(
  [
    '# Committed branch patch',
    committedPatch || '(none)',
    '# Staged patch',
    stagedPatch || '(none)',
    '# Unstaged patch',
    unstagedPatch || '(none)',
  ].join('\n\n'),
  maxPatchBytes,
)
write(join(outputDir, 'diff.patch'), patch)

const includedUntracked = untrackedChanged.filter((path) => includedFiles.includes(path))
let remainingUntrackedBytes = maxUntrackedTotalBytes
const untrackedSnippets = includedUntracked
  .map((path) => {
    if (remainingUntrackedBytes <= 0) {
      return `## ${path}\n\n[untracked file omitted because max untracked snippet budget was reached]\n`
    }
    if (!textFilePattern.test(path)) {
      return `## ${path}\n\n[untracked file omitted because extension does not look text-reviewable]\n`
    }
    if (!existsSync(path)) return `## ${path}\n\n[file no longer exists]\n`

    const maxBytes = Math.min(maxBytesForUntracked(path), remainingUntrackedBytes)
    const content = truncate(readFileSync(path, 'utf8'), maxBytes)
    remainingUntrackedBytes -= new TextEncoder().encode(content).length

    return `## ${path}\n\n\`\`\`${basename(path).split('.').pop() ?? 'text'}\n${content}\n\`\`\`\n`
  })
  .join('\n')

write(join(outputDir, 'untracked-files.md'), untrackedSnippets || '(none)\n')

const claudeProject = readIfExists('CLAUDE.md')
const canonicalWorkflow = readIfExists('CANONICAL_EDITING_WORKFLOW.md')

const context = `# yori-dict Review Context

Branch: ${branch}
HEAD: ${head}
Base ref: ${baseRef}
Base available: ${baseAvailable ? 'yes' : 'no'}
Claude CLI: ${claudeVersion}

## Scope Policy

Default excluded paths:

${defaultExcludedPrefixes.map((prefix) => `- ${prefix}`).join('\n')}
- ${[...defaultExcludedFiles].join('\n- ')}

Use \`--include-data\` only for reviews that intentionally target committed data artifacts.

## Project Instructions

${claudeProject || '(missing CLAUDE.md)'}

## Canonical Workflow Reference

${canonicalWorkflow || '(missing CANONICAL_EDITING_WORKFLOW.md)'}
`

write(join(outputDir, 'context.md'), context)

const validationCommands = `# Suggested Validation Commands

Choose only commands relevant to the changed files:

- bun test
- bun run typecheck
- bun test tests/domain/quality.test.ts
- bun test tests/pipeline/report-canonical-quality.test.ts
- bun test tests/pipeline/rebuild-canonical.test.ts
- bun test tests/runtime/canonical-lookup.test.ts
- bun run validate:canonical-overlays
- bun run quality:canonical

Do not run expensive import/rebuild commands unless the diff changes that pipeline and the reviewer explicitly asks for runtime validation.
`

write(join(outputDir, 'validation-commands.md'), validationCommands)

const bundle = `# Claude Review Bundle

This is a bounded review input. Review the changed behavior without broad repo discovery.

${context}

## Git Status

\`\`\`text
${status}
\`\`\`

## Included Changed Files

\`\`\`text
${includedFiles.join('\n') || '(none)'}
\`\`\`

## Excluded Changed Files

\`\`\`text
${excludedFiles.join('\n') || '(none)'}
\`\`\`

## Diffstat

\`\`\`text
${readIfExists(join(outputDir, 'diffstat.txt'))}
\`\`\`

## Patch

\`\`\`diff
${patch}
\`\`\`

## Untracked File Snippets

${untrackedSnippets || '(none)'}

${validationCommands}
`

write(join(outputDir, 'review-bundle.md'), bundle)

const claudeArgs = [
  'claude',
  '-p',
  bareMode ? '--bare' : '--safe-mode',
  '--name',
  `scoped-review-${runId}`,
  '--no-session-persistence',
  '--disable-slash-commands',
  '--model',
  model,
  '--effort',
  effort,
  '--max-turns',
  maxTurns,
  '--max-budget-usd',
  maxBudgetUsd,
  '--tools',
  tools,
  '--output-format',
  'stream-json',
  '--verbose',
  '--debug-file',
  join(outputDir, 'debug.log'),
  '--append-system-prompt-file',
  '.claude/prompts/review.md',
]

const shellCommand = `${claudeArgs.map((arg) => JSON.stringify(arg)).join(' ')} < ${JSON.stringify(
  join(outputDir, 'review-bundle.md'),
)} > ${JSON.stringify(join(outputDir, 'claude.stream.jsonl'))}`

write(join(outputDir, 'run-claude-review.sh'), `#!/usr/bin/env bash\nset -euo pipefail\n${shellCommand}\n`)

console.log(`Review bundle written to ${outputDir}`)
console.log(`Included files: ${includedFiles.length}`)
console.log(`Excluded files: ${excludedFiles.length}`)
console.log(`Patch bytes: ${new TextEncoder().encode(patch).length}`)

if (printCommand) {
  console.log('\nRun command:')
  console.log(shellCommand)
}

if (runClaude) {
  if (!commandExists('claude')) {
    console.error('Cannot run Claude review because `claude` is not available on PATH.')
    process.exit(1)
  }

  const reviewInput = readFileSync(join(outputDir, 'review-bundle.md'), 'utf8')
  const result = Bun.spawnSync(claudeArgs, {
    stdin: new TextEncoder().encode(reviewInput),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  write(join(outputDir, 'claude.stream.jsonl'), new TextDecoder().decode(result.stdout))
  write(join(outputDir, 'claude.stderr.log'), new TextDecoder().decode(result.stderr))

  if (result.exitCode !== 0) {
    console.error(`Claude review failed with exit code ${result.exitCode}`)
    process.exit(result.exitCode)
  }

  console.log(`Claude review output written to ${join(outputDir, 'claude.stream.jsonl')}`)
}
