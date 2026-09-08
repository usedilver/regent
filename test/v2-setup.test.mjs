import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setup, requestArgs } from '../src/v2/setup.ts'
import { loadConfig, workspaceDir, defaultRepoDir } from '../src/v2/config.ts'
import { repositoryRequest, isolationFor } from '../src/v2/repository.ts'
import { Store } from '../src/v2/store.ts'
import { Core } from '../src/v2/core.ts'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-setup-')))
const configFile = path.join(root, 'config/regent.yaml')
let core, store
try {
  const repo = path.join(root, 'default'), other = path.join(root, 'other repo')
  for (const dir of [repo, other]) {
    execFileSync('git', ['init', dir], { stdio: 'ignore' })
    fs.writeFileSync(path.join(dir, '.env'), `SETUP_FIXTURE_REPO=${path.basename(dir)}\n`)
  }
  const result = setup(['--repo', repo, '--team', 'T1', '--user', 'U1'], configFile)
  assert.match(result, /Configuracion creada/)
  assert.match(result, /no aplica allow\/ask\/deny/)
  const original = fs.readFileSync(configFile, 'utf8')
  assert.doesNotMatch(original, /TOKEN|API_KEY|notion|policy|projects|skills/)
  const config = loadConfig(configFile)
  assert.equal(workspaceDir(config), root)
  assert.equal(defaultRepoDir(config, root), repo)
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600)
  assert.throws(() => setup(['--repo', other, '--team', 'T1', '--user', 'U1'], configFile), /no se sobrescribio/)
  assert.equal(fs.readFileSync(configFile, 'utf8'), original)
  assert.throws(() => setup(['--repo', repo, '--workspace', other, '--team', 'T1', '--user', 'U1'], path.join(root, 'invalid.yaml')), /workspace/)
  assert.throws(() => setup(['--repo', repo, '--team', 'T1', '--user', 'U1', '--user', 'U2'], path.join(root, 'invalid.yaml')), /solo usuario/)
  assert.ok(!fs.existsSync(path.join(root, 'invalid.yaml')))
  assert.throws(() => loadConfig(path.join(root, 'missing.yaml')), /regent setup/)
  const teamFile = path.join(root, 'team.yaml')
  setup(['--repo', other, '--workspace', root, '--team', 'T1', '--user', 'U1', '--user', 'U2', '--mode', 'team', '--permissions', 'native'], teamFile)
  assert.equal(loadConfig(teamFile).permission_mode, 'native')
  assert.deepEqual(loadConfig(teamFile).slack.allowed_users, ['U1', 'U2'])
  // Setup must not open the runtime database, including with a nonexistent DB parent.
  execFileSync(process.execPath, ['src/v2/cli.ts', 'setup', '--repo', repo, '--team', 'T1', '--user', 'U1'], {
    env: { ...process.env, REGENT_CONFIG: path.join(root, 'cli.yaml'), REGENT_DB: path.join(root, 'unused/db.sqlite') }, stdio: 'pipe',
  })
  assert.ok(!fs.existsSync(path.join(root, 'unused')))
  console.log('  OK minimal setup, private config, no overwrites/secrets/DB, independent team/native configuration')

  assert.deepEqual(requestArgs(['Question', '--repo', 'other repo', '--conversation', 'review']), { text: 'Question', repo: 'other repo', conversation: 'review' })
  assert.throws(() => requestArgs(['Question', '--repo']), /argument/)
  assert.throws(() => requestArgs(['--conversation', 'review']), /texto/)
  assert.deepEqual(repositoryRequest('repo: "other repo"\nReview this'), { repo: 'other repo', text: 'Review this' })
  assert.deepEqual(repositoryRequest('Review https://example.org/bug'), { text: 'Review https://example.org/bug' })
  assert.throws(() => repositoryRequest('repo: missing'), /siguiente linea/)
  const starts = []
  store = new Store(':memory:')
  core = new Core({ config, store, cwd: root,
    output: { async notice() {}, async status() {}, async finish() {}, async delta() {} },
    runner: options => {
      options.onEvent({ kind: 'init', sessionId: `session-${starts.length}` })
      let resolve
      const done = new Promise(r => { resolve = r })
      starts.push(options)
      return { done, cancel: () => resolve({ state: 'interrupted', text: '', error: '', cost: 0, usage: {} }) }
    } })
  const input = (key, text, extra = {}) => ({ adapter: 'slack', key, eventId: key, author: 'U1', team: 'T1', channel: 'C1', thread: key, text, ...extra })
  await core.submit(input('default', 'Investigate this URL https://example.org'))
  await core.submit(input('explicit', 'repo: other repo\nReview this'))
  await core.submit(input('cli', 'Review this', { adapter: 'cli', repo: 'other repo' }))
  assert.equal(starts[0].cwd, repo)
  assert.equal(starts[1].cwd, other)
  assert.equal(starts[2].cwd, other)
  assert.equal(starts[1].env.SETUP_FIXTURE_REPO, 'other repo')
  assert.equal(starts[1].worktreeName, isolationFor(other, 'explicit').name)
  assert.equal(starts[1].sessionId, null)
  assert.equal(store.run(store.db.prepare("SELECT run_id FROM inbound WHERE event_id='explicit'").get().run_id).prompt, 'Review this')
  const invalid = input('invalid', 'repo: missing\nReview this')
  await assert.rejects(() => core.submit(invalid), /ENOENT/)
  assert.equal(store.conversation('invalid'), undefined)
  const switching = await core.submit(input('default', 'Review this', { eventId: 'switch', repo: 'other repo' }))
  assert.match(store.run(switching.runId).prompt, /regent_use_repo/)
  assert.equal(store.run(switching.runId).state, 'queued')
  assert.equal(store.conversation('default').cwd, repo)
  const duplicate = await core.submit(input('explicit', 'repo: missing\nRetry'))
  assert.equal(duplicate.duplicate, true)
  console.log('  OK default and explicit initial context, repo environment/isolation, invalid paths and duplicate events')
} finally {
  if (core) await core.close()
  if (store) store.close()
  fs.rmSync(root, { recursive: true, force: true })
}
