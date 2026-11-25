import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { workspaceGit } from './worktree-cleanup.ts'

const execute = promisify(execFile)

interface PullRequest {
  number: number
  state: string
  headRefOid: string
  url?: string
}

type Inspector = (directory: string, branch: string, signal?: AbortSignal) => Promise<PullRequest[]>

export async function githubPullRequests(
  directory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<PullRequest[]> {
  const origin = await workspaceGit(directory, ['remote', 'get-url', 'origin'], signal)
  const repository = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(origin)?.[1]
  if (!repository) return []
  const { stdout } = await execute(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'all',
      '--head',
      branch,
      '--limit',
      '100',
      '--json',
      'number,state,headRefOid,url',
    ],
    { cwd: directory, signal, timeout: 20000, maxBuffer: 1024 * 1024 },
  )
  return JSON.parse(stdout) as PullRequest[]
}

function latest(requests: PullRequest[]): PullRequest | undefined {
  return requests.toSorted((a, b) => b.number - a.number)[0]
}

export async function publishGitBranch(
  directory: string,
  action: 'push' | 'delete_branch',
  branch: string,
  signal?: AbortSignal,
  inspect: Inspector = githubPullRequests,
) {
  const repositoryRoot = await workspaceGit(directory, ['rev-parse', '--show-toplevel'], signal)
  if (fs.realpathSync(repositoryRoot) !== fs.realpathSync(directory)) {
    throw new Error(
      'Indica la raíz de un repositorio preparado, no un subdirectorio o submódulo sin checkout.',
    )
  }
  await workspaceGit(directory, ['check-ref-format', `refs/heads/${branch}`], signal)
  const request = latest(await inspect(directory, branch, signal))
  if (action === 'push') {
    if (request && request.state !== 'OPEN') {
      throw new Error(
        `El PR #${request.number} de esa rama está ${request.state}. Publica los cambios en una rama nueva y abre otro PR; el PR cerrado no recibirá este commit.`,
      )
    }
    const head = await workspaceGit(directory, ['rev-parse', 'HEAD'], signal)
    await workspaceGit(directory, ['push', 'origin', `HEAD:refs/heads/${branch}`], signal)
    const remote = await workspaceGit(
      directory,
      ['ls-remote', 'origin', `refs/heads/${branch}`],
      signal,
    )
    if (remote.split(/\s+/)[0] !== head)
      throw new Error('El remoto no confirmó el commit publicado.')
    const verified = latest(await inspect(directory, branch, signal))
    if (verified && verified.state !== 'OPEN') {
      return {
        state: 'pushed_after_close',
        branch,
        commit: head,
        pull_request: verified.number,
        instruction:
          'The commit is backed up on the remote branch, but its PR closed during publication. Do not claim that PR includes this commit. Publish a new branch and open a new PR.',
      }
    }
    if ((request || verified) && verified?.headRefOid !== head) {
      return {
        state: 'pushed',
        branch,
        commit: head,
        pull_request_verified: false,
        instruction:
          'The remote branch is verified, but GitHub has not confirmed the PR head. Do not claim the PR contains this commit until its head is verified.',
      }
    }
    return {
      state: 'pushed',
      branch,
      commit: head,
      pull_request: verified?.number,
      pull_request_verified: Boolean(verified),
    }
  }

  if (request?.state === 'OPEN')
    throw new Error(
      `El PR #${request.number} sigue abierto. Ciérralo o intégralo antes de eliminar su rama.`,
    )
  const defaultRef = await workspaceGit(
    directory,
    ['ls-remote', '--symref', 'origin', 'HEAD'],
    signal,
  )
  if (defaultRef.startsWith(`ref: refs/heads/${branch}\t`))
    throw new Error('No se elimina la rama predeterminada del remoto.')
  await workspaceGit(directory, ['fetch', '--prune', '--no-recurse-submodules', 'origin'], signal)
  const remote = await workspaceGit(
    directory,
    ['ls-remote', 'origin', `refs/heads/${branch}`],
    signal,
  )
  if (!remote) return { state: 'absent', branch }
  const head = remote.split(/\s+/)[0]
  const pullRefs: string[] = []
  if (request) {
    const ref = `refs/regent/publication/pr-${request.number}`
    await workspaceGit(
      directory,
      ['fetch', '--no-recurse-submodules', 'origin', `refs/pull/${request.number}/head:${ref}`],
      signal,
    )
    pullRefs.push(ref)
  }
  const refs = (
    await workspaceGit(
      directory,
      [
        'for-each-ref',
        '--format=%(refname)',
        '--contains',
        head,
        'refs/remotes/origin',
        ...pullRefs,
      ],
      signal,
    )
  )
    .split('\n')
    .filter(
      (ref) => ref && ref !== `refs/remotes/origin/${branch}` && ref !== 'refs/remotes/origin/HEAD',
    )
  const liveHeads = new Set(
    (await workspaceGit(directory, ['ls-remote', '--heads', 'origin'], signal))
      .split('\n')
      .map((line) => line.split(/\s+/)[1])
      .filter(Boolean),
  )
  const verifiedRefs = refs.filter(
    (ref) =>
      pullRefs.includes(ref) || liveHeads.has(ref.replace('refs/remotes/origin/', 'refs/heads/')),
  )
  if (!verifiedRefs.length) {
    throw new Error(
      `La rama contiene el commit ${head.slice(0, 12)} sin otro respaldo remoto verificable. Conserva la rama y publica un PR nuevo para esos cambios antes de limpiarla.`,
    )
  }
  const current = await workspaceGit(
    directory,
    ['ls-remote', 'origin', `refs/heads/${branch}`],
    signal,
  )
  if (current.split(/\s+/)[0] !== head)
    throw new Error('La rama cambió durante la verificación; vuelve a comprobarla.')
  await workspaceGit(
    directory,
    ['push', `--force-with-lease=refs/heads/${branch}:${head}`, 'origin', `:refs/heads/${branch}`],
    signal,
  )
  if (await workspaceGit(directory, ['ls-remote', 'origin', `refs/heads/${branch}`], signal)) {
    throw new Error('El remoto no confirmó la eliminación de la rama.')
  }
  return { state: 'deleted', branch, preserved_commit: head, backup_refs: verifiedRefs }
}
