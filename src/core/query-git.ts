import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
export async function queryGit(
  root: string,
  operation: string,
  args: string[],
  directory = '.',
  signal?: AbortSignal,
) {
  if (!operations.has(operation)) throw new Error('Git operation is not a reader.')
  const forbidden = [
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
  if (
    args.some(
      (arg) =>
        (arg !== '--' &&
          arg.startsWith('--') &&
          forbidden.some((flag) => flag.startsWith(arg.split('=')[0]))) ||
        /\.credentials\.json|\.claude\.json/.test(arg),
    )
  )
    throw new Error('Git option is not allowed in query mode.')
  const base = fs.realpathSync(root),
    cwd = fs.realpathSync(path.resolve(base, directory))
  const relative = path.relative(base, cwd)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(
      'Read Git inside the selected project; use regent_use_repo for another project.',
    )
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '0',
    GIT_PAGER: 'cat',
  }
  const common = [
    '--no-pager',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.pager=cat',
  ]
  // Read-only Git commands can still run configured clean/process filters. Disable them
  // for this invocation rather than changing repository configuration.
  let filters = ''
  try {
    filters = (
      await execute(
        'git',
        [
          ...common,
          'config',
          '--null',
          '--name-only',
          '--get-regexp',
          '^filter\..*\.(clean|smudge|process|required)$',
        ],
        { cwd, env, signal, timeout: 15000, maxBuffer: 65536, encoding: 'utf8' },
      )
    ).stdout
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error
  }
  for (const key of filters.split('\0').filter(Boolean))
    common.push('-c', key + (key.endsWith('.required') ? '=false' : '='))
  const flags = ['log', 'show', 'diff'].includes(operation)
    ? ['--no-ext-diff', '--no-textconv']
    : operation === 'blame'
      ? ['--no-textconv']
      : []
  const result = await execute(
    'git',
    [
      ...common,
      ...(operation === 'worktrees' ? ['worktree', 'list'] : [operation]),
      ...flags,
      ...args,
    ],
    { cwd, env, signal, timeout: 15000, maxBuffer: 512 * 1024, encoding: 'utf8' },
  )
  return { output: result.stdout, warnings: result.stderr }
}
