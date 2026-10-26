import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isInside } from './repository.ts'

const execute = promisify(execFile)

export const GitReadOperations = [
  'log',
  'show',
  'diff',
  'status',
  'ls-files',
  'ls-tree',
  'blame',
  'rev-parse',
  'worktrees',
] as const

const operations = new Set<string>(GitReadOperations)
const GIT_TIMEOUT_MS = 15000
const OUTPUT_BYTES = 512 * 1024
const CREDENTIAL_FILES = /\.credentials\.json|\.claude\.json/
/** Options that write, run external programs or escape the repository. */
const FORBIDDEN_FLAGS = [
  '--output',
  '--ext-diff',
  '--textconv',
  '--no-index',
  '--exec',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--show-signature',
]
const BASE_FLAGS = [
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.pager=cat',
]

function assertReadOnlyArgs(args: string[]): void {
  const forbidden = (arg: string) =>
    arg !== '--' &&
    arg.startsWith('--') &&
    FORBIDDEN_FLAGS.some((flag) => flag.startsWith(arg.split('=')[0]))

  if (args.some((arg) => forbidden(arg) || CREDENTIAL_FILES.test(arg))) {
    throw new Error('Git option is not allowed in query mode.')
  }
}

/** A minimal environment: no user config, no prompts, no pager. */
function readerEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '0',
    GIT_PAGER: 'cat',
  }
}

/**
 * Read-only Git commands can still run configured clean/smudge/process filters. Returns the
 * `-c` overrides that disable them for this invocation, without touching the repository config.
 */
async function filterOverrides(
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string[]> {
  let configured = ''

  try {
    const result = await execute(
      'git',
      [
        ...BASE_FLAGS,
        'config',
        '--null',
        '--name-only',
        '--get-regexp',
        '^filter\\..*\\.(clean|smudge|process|required)$',
      ],
      { cwd, env, signal, timeout: GIT_TIMEOUT_MS, maxBuffer: 65536, encoding: 'utf8' },
    )

    configured = result.stdout
  } catch (error) {
    // Exit code 1 only means that no filter is configured.
    if ((error as { code?: number }).code !== 1) throw error
  }

  return configured
    .split('\0')
    .filter(Boolean)
    .flatMap((key) => ['-c', key + (key.endsWith('.required') ? '=false' : '=')])
}

function operationFlags(operation: string): string[] {
  if (['log', 'show', 'diff'].includes(operation)) return ['--no-ext-diff', '--no-textconv']
  if (operation === 'blame') return ['--no-textconv']
  return []
}

export async function queryGit(
  root: string,
  operation: string,
  args: string[],
  directory = '.',
  signal?: AbortSignal,
) {
  if (!operations.has(operation)) throw new Error('Git operation is not a reader.')
  assertReadOnlyArgs(args)
  const base = fs.realpathSync(root)
  const cwd = fs.realpathSync(path.resolve(base, directory))

  if (!isInside(base, cwd)) {
    throw new Error(
      'Read Git inside the selected project; use regent_use_repo for another project.',
    )
  }

  const env = readerEnv()
  const command = operation === 'worktrees' ? ['worktree', 'list'] : [operation]
  const result = await execute(
    'git',
    [
      ...BASE_FLAGS,
      ...(await filterOverrides(cwd, env, signal)),
      ...command,
      ...operationFlags(operation),
      ...args,
    ],
    { cwd, env, signal, timeout: GIT_TIMEOUT_MS, maxBuffer: OUTPUT_BYTES, encoding: 'utf8' },
  )

  return { output: result.stdout, warnings: result.stderr }
}
