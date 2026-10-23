import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { startRunner } from '../src/execution/runner.ts'
import { ConfigSchema } from '../src/config.ts'
import { REGENT_DIR } from '../src/env.ts'
import { AccessPolicy } from '../src/core/access-policy.ts'
import { loadAccess, AccessReloader } from '../src/access.ts'
import { SlackAccess } from '../src/adapters/slack/access.ts'
import { Store } from '../src/storage/store.ts'
import { Core } from '../src/core/core.ts'
import { createRuntime } from '../src/runtime.ts'

const output = { async notice() {}, async status() {}, async delta() {}, async finish() {} }
const document = (users = ['U1'], emails = ['alice@example.test']) => ({
  slack: { allowed_users: users },
  oauth: { allowed_emails: emails },
})
const until = async (condition, timeout = 5000) => {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-access-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'access.yaml')
  const write = (value) => fs.writeFileSync(file, YAML.stringify(value))
  write(document())
  const config = ConfigSchema.parse({
    access_policy_file: file,
    auth: { mode: 'team' },
    repos: { path: root },
    slack: { workspace_team_id: 'T1', allowed_users: ['STALE'] },
  })
  return { root, file, write, config }
}
function reloader(config, report = () => {}, changed) {
  const loaded = loadAccess(config)
  return new AccessReloader(loaded.policy, loaded.file, {
    oauthRequired: true,
    contentHash: loaded.contentHash,
    report,
    changed,
  })
}
const inbound = (eventId, author = 'U1', key = 'shared') => ({
  adapter: 'slack',
  key,
  eventId,
  author,
  team: 'T1',
  channel: 'C1',
  text: 'Review this',
})
const result = { state: 'completed', text: 'done', error: '', cost: 0, usage: {} }
function queuedCore(t, config, policy) {
  const store = new Store(':memory:')
  const controllers = []
  const core = new Core({
    config: { ...config, auth: { mode: 'indie' } },
    access: policy,
    store,
    output,
    cwd: config.repos.path,
    runner: (options) => {
      let finish
      const done = new Promise((resolve) => {
        finish = resolve
      })
      const controller = {
        options,
        done,
        finish: () => finish(result),
        cancelled: false,
        cancel() {
          this.cancelled = true
          finish(result)
        },
      }
      controllers.push(controller)
      return controller
    },
  })
  t.after(async () => {
    await core.close()
    store.close()
  })
  return { core, store, controllers }
}

test('policy snapshots are immutable, normalized and atomically replaced', () => {
  const policy = new AccessPolicy(document(['U2', 'U1', 'U1'], ['ALICE@example.test']))
  const original = policy.snapshot,
    version = policy.version
  assert.deepEqual(original.slack.allowed_users, ['U1', 'U2'])
  assert.ok(policy.allowsOAuth('Alice@example.test'))
  assert.throws(() => original.slack.allowed_users.push('U3'), TypeError)
  assert.equal(policy.replace(document(['U1', 'U2'], ['alice@example.test'])), false)
  assert.equal(policy.version, version)
  assert.throws(() => policy.replace(document(['U3'], [])))
  assert.equal(policy.snapshot, original)
  assert.ok(!policy.allowsSlack('U3'))
})

test('external policy overrides inline lists, resolves installation-relative paths and fails closed at startup', (t) => {
  const f = fixture(t),
    loaded = loadAccess(f.config)
  assert.ok(loaded.policy.allowsSlack('U1'))
  assert.ok(!loaded.policy.allowsSlack('STALE'))
  assert.equal(
    loadAccess({ ...f.config, access_policy_file: path.relative(REGENT_DIR, f.file) }).file,
    f.file,
  )
  const legacy = loadAccess({ ...f.config, access_policy_file: null })
  assert.ok(legacy.policy.allowsSlack('STALE'))
  assert.equal(legacy.file, undefined)
  fs.unlinkSync(f.file)
  assert.throws(() => loadAccess(f.config), /rejected \(read\)/)
  f.write({ oauth: { allowed_emails: ['alice@example.test'] } })
  assert.throws(() => loadAccess(f.config), /schema/)
  assert.throws(
    () => new Core({ config: f.config, cwd: f.root, store: {}, output }),
    /Load access_policy_file/,
  )
})

test('invalid, missing, oversized and partial files retain the entire last valid policy with safe diagnostics', (t) => {
  const f = fixture(t),
    logs = [],
    loader = reloader(f.config, (message) => logs.push(message))
  t.after(() => loader.close())
  const original = loader.policy.snapshot
  const invalid = [
    'secret: [unterminated-sensitive-value',
    'secret: !sensitive-tag sensitive-value',
    YAML.stringify(document(['U2'], [])),
    YAML.stringify({ slack: { allowed_users: ['U2'] } }),
    YAML.stringify({ ...document(['U2']), secret: 'sensitive-value' }),
    'x'.repeat(128 * 1024 + 1),
  ]
  for (const content of invalid) {
    fs.writeFileSync(f.file, content)
    assert.equal(loader.reload(), false)
    assert.equal(loader.policy.snapshot, original)
    const count = logs.length
    loader.reload()
    assert.equal(logs.length, count)
  }
  fs.unlinkSync(f.file)
  loader.reload()
  loader.reload()
  assert.equal(loader.policy.snapshot, original)
  f.write(document())
  loader.reload()
  assert.match(logs.at(-1), /valid again/)
  assert.doesNotMatch(logs.join('\n'), /sensitive-value|alice@example/)
  f.write(document(['U2'], ['bob@example.test']))
  assert.equal(loader.reload(), true)
  assert.ok(loader.policy.allowsSlack('U2'))
  assert.ok(loader.policy.allowsOAuth('bob@example.test'))
  assert.ok(!loader.policy.allowsOAuth('alice@example.test'))
  assert.match(logs.at(-1), /Slack=1, OAuth=1/)
})

test('atomic replacement, reorder-only edits and recovery with identical effective policy', (t) => {
  const f = fixture(t),
    logs = [],
    loader = reloader(f.config, (message) => logs.push(message))
  t.after(() => loader.close())
  const next = f.file + '.next'
  fs.writeFileSync(next, YAML.stringify(document(['U2', 'U1'])))
  fs.renameSync(next, f.file)
  assert.equal(loader.reload(), true)
  const version = loader.policy.version,
    count = logs.length
  fs.writeFileSync(f.file, '# reordered\n' + YAML.stringify(document(['U1', 'U2', 'U1'])))
  assert.equal(loader.reload(), false)
  assert.equal(loader.policy.version, version)
  assert.equal(logs.length, count)
  fs.unlinkSync(f.file)
  loader.reload()
  f.write(document(['U1', 'U2', 'U1']))
  assert.equal(loader.reload(), false)
  assert.match(logs.at(-1), /valid again/)
  f.write(document([]))
  assert.equal(loader.reload(), true)
  assert.match(logs.at(-1), /empty list broadens access/)
})

test('OAuth without an inline allowlist requires an external valid email policy', (t) => {
  const f = fixture(t)
  const raw = {
    ...f.config,
    mcp: {
      enabled: true,
      oauth: {
        issuer_url: 'https://code.example.test',
        redirect_uris: ['https://client.example.test/callback'],
        oidc: {
          issuer_url: 'https://accounts.example.test',
          client_id: 'fixture',
          client_secret_env: 'REGENT_TEST_SECRET',
        },
      },
    },
  }
  const parsed = ConfigSchema.parse(raw)
  assert.ok(loadAccess(parsed).policy.allowsOAuth('alice@example.test'))
  assert.throws(() => ConfigSchema.parse({ ...raw, access_policy_file: null }))
  f.write({ slack: { allowed_users: ['U1'] } })
  assert.throws(() => loadAccess(parsed), /oauth.allowed_emails/)
})

test('Slack membership cache never caches access-list decisions or bypasses a concurrent withdrawal', async () => {
  const policy = new AccessPolicy(document([]))
  let calls = 0,
    resolve
  const member = { team_id: 'T1' }
  const access = new SlackAccess(policy, 'T1', async () => {
    calls++
    return member
  })
  assert.ok(await access.allowed('U1'))
  assert.ok(await access.allowed('U1'))
  assert.equal(calls, 1)
  policy.replace(document(['U2']))
  assert.ok(!(await access.allowed('U1')))
  assert.ok(await access.allowed('U2'))
  policy.replace(document([]))
  const pending = new SlackAccess(
    policy,
    'T1',
    () =>
      new Promise((r) => {
        resolve = r
      }),
  ).allowed('U1')
  policy.replace(document(['U2']))
  resolve(member)
  assert.ok(!(await pending))
  policy.replace(document([]))
  for (const denied of [
    { team_id: 'OTHER' },
    { ...member, deleted: true },
    { ...member, is_bot: true },
    { ...member, is_stranger: true },
    undefined,
  ]) {
    const verifier = new SlackAccess(policy, 'T1', async () => denied)
    assert.ok(!(await verifier.allowed('U1')))
  }
})

test('withdrawal interrupts only that author’s queued work, while active work and other room members continue', async (t) => {
  const f = fixture(t)
  f.write(document(['U1', 'U2']))
  const loader = reloader(
    f.config,
    () => {},
    () => core.pump(),
  )
  const { core, store, controllers } = queuedCore(t, f.config, loader.policy)
  t.after(() => loader.close())
  const active = await core.submit(inbound('active'))
  await until(() => controllers.length === 1)
  const withdrawn = await core.submit(inbound('withdrawn'))
  const allowed = await core.submit(inbound('allowed', 'U2'))
  assert.equal(store.conversation('shared').author, 'U2')
  f.write(document(['U2']))
  loader.reload()
  assert.equal(store.run(withdrawn.runId).state, 'interrupted')
  assert.match(store.run(withdrawn.runId).error, /Access withdrawn/)
  assert.equal(store.run(active.runId).state, 'running')
  assert.equal(store.run(allowed.runId).state, 'queued')
  assert.equal(store.conversation('shared').state, 'running')
  assert.ok(!controllers[0].cancelled)
  await assert.rejects(() => core.submit(inbound('denied')), /autorizada/)
  await assert.rejects(
    () => core.answerQuestion('fixture', 0, 'U1', 'T1', 'C1', null),
    /no autorizado/,
  )
  await core.tool([...core.active.values()][0].token, 'regent_status', {
    text: 'Finishing the admitted run',
  })
  controllers[0].finish()
  await until(() => controllers.length === 2)
  assert.equal(controllers[1].options.runId, allowed.runId)
  controllers[1].finish()
  await until(() => core.active.size === 0)
  f.write(document(['U1', 'U2']))
  loader.reload()
  assert.equal(store.run(withdrawn.runId).state, 'interrupted')
  assert.equal(controllers.length, 2)
  assert.equal(store.run(withdrawn.runId).prompt, 'Review this')
})

test('admission rechecks run authors, preserves manual pauses and retains withdrawal when preparation fails', async (t) => {
  const f = fixture(t),
    policy = loadAccess(f.config).policy
  const { core, store, controllers } = queuedCore(t, f.config, policy)
  const bad = store.accept(inbound('bad', 'U1', 'mixed'), f.root)
  const good = store.accept(inbound('good', 'U2', 'mixed'), f.root)
  store.accept(inbound('paused', 'U2', 'paused'), f.root)
  store.state('paused', 'interrupted')
  policy.replace(document(['U2']))
  core.pump()
  await until(() => controllers.length === 1)
  assert.equal(store.run(bad.runId).state, 'interrupted')
  assert.equal(controllers[0].options.runId, good.runId)
  assert.equal(store.conversation('paused').state, 'interrupted')
  let reject
  policy.replace(document(['U1', 'U2']))
  const preparing = core.submit(
    inbound('preparing', 'U1', 'preparing'),
    () =>
      new Promise((_r, no) => {
        reject = no
      }),
  )
  await until(() => Boolean(reject))
  policy.replace(document(['U2']))
  core.pump()
  reject(new Error('fixture preparation failed'))
  const accepted = await preparing
  assert.equal(store.run(accepted.runId).state, 'interrupted')
  assert.match(store.run(accepted.runId).error, /Access withdrawn/)
  controllers[0].finish()
  await until(() => core.active.size === 0)
})

for (const mode of ['slack', 'mcp']) {
  test(`${mode} runtime reloads within five seconds, preserves PID, and stops polling on close`, async (t) => {
    const f = fixture(t)
    process.env.REGENT_MCP_TOKEN_POLICY_FIXTURE = 'fixture-token-'.repeat(4)
    const config = ConfigSchema.parse({
      ...f.config,
      mcp: {
        enabled: true,
        principals: [{ id: 'fixture', token_env: 'REGENT_MCP_TOKEN_POLICY_FIXTURE' }],
      },
    })
    const runtime = createRuntime(config, {
      claudeVersion: 'fixture',
      store: new Store(':memory:'),
      port: 0,
      slack:
        mode === 'slack'
          ? { output, connected: () => true, async start() {}, async stop() {} }
          : undefined,
    })
    t.after(() => runtime.close())
    const pid = process.pid
    await runtime.start()
    f.write(document(['U2']))
    await until(() => runtime.core.access.allowsSlack('U2'))
    assert.equal(process.pid, pid)
    await runtime.close()
    f.write(document(['U3']))
    await new Promise((resolve) => setTimeout(resolve, 2100))
    assert.ok(!runtime.core.access.allowsSlack('U3'))
  })
}

test('a real executor subprocess finishes after access withdrawal without a signal or restart', async (t) => {
  const f = fixture(t),
    policy = loadAccess(f.config).policy
  const probe = path.join(f.root, 'executor.mjs'),
    marker = path.join(f.root, 'pid')
  fs.writeFileSync(
    probe,
    `import fs from 'node:fs'
for await (const _chunk of process.stdin) {}
fs.writeFileSync(process.env.ACCESS_MARKER, String(process.pid))
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture'}))
await new Promise(resolve => setTimeout(resolve, 400))
console.log(JSON.stringify({type:'result',result:'completed after withdrawal',total_cost_usd:0,usage:{}}))
`,
  )
  const store = new Store(':memory:')
  const core = new Core({
    config: { ...f.config, auth: { mode: 'indie' } },
    access: policy,
    store,
    output,
    cwd: f.root,
    runner: startRunner,
    runnerOverrides: {
      command: process.execPath,
      prefixArgs: [probe],
      env: { ...process.env, ACCESS_MARKER: marker },
    },
  })
  t.after(async () => {
    await core.close()
    store.close()
  })
  const accepted = await core.submit(inbound('subprocess'))
  await until(() => fs.existsSync(marker))
  const pid = Number(fs.readFileSync(marker, 'utf8'))
  policy.replace(document(['U2']))
  core.pump()
  process.kill(pid, 0)
  const active = [...core.active.values()][0]
  assert.ok(!active.cancelled)
  await active.done
  assert.equal(store.run(accepted.runId).state, 'completed')
  assert.equal(store.run(accepted.runId).result, 'completed after withdrawal')
})

test('failed startup never starts a policy poller', async (t) => {
  const f = fixture(t),
    store = new Store(':memory:')
  const runtime = createRuntime(f.config, {
    store,
    claudeVersion: 'fixture',
    port: 0,
    slack: {
      output,
      connected: () => false,
      async start() {
        throw new Error('fixture failure')
      },
      async stop() {},
    },
  })
  await assert.rejects(runtime.start(), /fixture failure/)
  f.write(document(['U3']))
  await new Promise((resolve) => setTimeout(resolve, 2100))
  assert.ok(!runtime.core.access.allowsSlack('U3'))
  await runtime.close()
})

test(
  'development watcher applies access edits without restarting the server',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = fixture(t)
    fs.mkdirSync(path.join(f.root, 'config'))
    fs.mkdirSync(path.join(f.root, 'src'))
    fs.mkdirSync(path.join(f.root, 'plugins/executor'), { recursive: true })
    fs.writeFileSync(path.join(f.root, '.env'), '')
    const file = path.join(f.root, 'config/access.yaml')
    fs.writeFileSync(file, YAML.stringify(document()))
    const dev = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts.dev.split(' ')
    assert.equal(dev.shift(), 'node')
    dev[dev.length - 1] = path.resolve('test/fixtures/access-runtime.mjs')
    let logs = ''
    const child = spawn(process.execPath, dev, {
      cwd: f.root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ACCESS_RUNTIME_MODULE: pathToFileURL(path.resolve('src/runtime.ts')).href,
        ACCESS_CONFIG_MODULE: pathToFileURL(path.resolve('src/config.ts')).href,
        ACCESS_STORE_MODULE: pathToFileURL(path.resolve('src/storage/store.ts')).href,
      },
    })
    child.stdout.on('data', (chunk) => {
      logs += chunk
    })
    child.stderr.on('data', (chunk) => {
      logs += chunk
    })
    const stopped = new Promise((resolve) => child.once('exit', resolve))
    t.after(async () => {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {}
      await stopped
    })
    const status = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(f.root, 'status.json'), 'utf8'))
      } catch {
        return undefined
      }
    }
    await until(() => status()?.users.includes('U1'))
    const pid = status().pid
    fs.writeFileSync(file, YAML.stringify(document(['U2'])))
    await until(() => status()?.users.includes('U2'))
    assert.equal(status().pid, pid, logs)
    assert.doesNotMatch(logs, /Restarting/)
  },
)

test('automatic repository continuations recheck authorization before starting', async (t) => {
  const f = fixture(t),
    policy = loadAccess(f.config).policy
  const other = path.join(f.root, 'other')
  fs.mkdirSync(path.join(other, '.git'), { recursive: true })
  const { core, store, controllers } = queuedCore(t, f.config, policy)
  await core.submit(inbound('switch'))
  await until(() => controllers.length === 1)
  const active = [...core.active.values()][0]
  policy.replace(document(['U2']))
  const selected = await core.tool(active.token, 'regent_use_repo', {
    repo: other,
    handoff: 'Continue the work',
  })
  assert.ok(selected.switching)
  controllers[0].finish()
  await until(() => core.active.size === 0)
  const continuation = store.db.prepare('SELECT * FROM runs WHERE id != ?').get(active.run.id)
  assert.equal(continuation.author, 'U1')
  assert.equal(continuation.state, 'interrupted')
  assert.match(continuation.error, /Access withdrawn/)
  assert.equal(controllers.length, 1)
  policy.replace(document(['U1']))
  core.pump()
  assert.equal(controllers.length, 1)
})

test('policy edits during startup do not run queued work before recovery', async (t) => {
  const f = fixture(t),
    store = new Store(':memory:')
  const denied = store.accept(inbound('denied', 'U1', 'one'), f.root)
  const allowed = store.accept(inbound('allowed', 'U2', 'two'), f.root)
  const controllers = []
  const runtime = createRuntime(
    { ...f.config, auth: { mode: 'indie' } },
    {
      store,
      port: 0,
      claudeVersion: 'fixture',
      slack: {
        output,
        connected: () => true,
        async start() {
          f.write(document(['U2']))
        },
        async stop() {},
      },
    },
  )
  runtime.core.runner = () => {
    let finish
    const done = new Promise((resolve) => {
      finish = resolve
    })
    const controller = { done, cancel: () => finish(result) }
    controllers.push(controller)
    return controller
  }
  t.after(() => runtime.close())
  await runtime.start()
  await until(() => controllers.length === 1)
  assert.equal(store.run(denied.runId).state, 'interrupted')
  assert.equal(store.run(allowed.runId).state, 'running')
})

test('queued OAuth callers follow the live policy while technical MCP principals remain boot-configured', async (t) => {
  const f = fixture(t)
  const config = ConfigSchema.parse({
    ...f.config,
    limits: { max_concurrent_runs: 1 },
    mcp: { enabled: true, principals: [{ id: 'service', token_env: 'REGENT_MCP_TOKEN_SERVICE' }] },
  })
  const loader = reloader(
    config,
    () => {},
    () => core.pump(),
  )
  t.after(() => loader.close())
  const { core, store, controllers } = queuedCore(t, config, loader.policy)
  core.mcpIdentity = (author) =>
    author === 'mcp:alice' && loader.policy.allowsOAuth('alice@example.test')
      ? { email: 'alice@example.test', name: 'Alice' }
      : undefined
  const mcp = (id, author, key) => ({ ...inbound(id, author, key), adapter: 'mcp' })
  const active = await core.submit(mcp('oauth-active', 'mcp:alice', 'oauth'))
  await until(() => controllers.length === 1)
  const waiting = await core.submit(mcp('oauth-pending', 'mcp:alice', 'oauth'))
  const service = await core.submit(mcp('technical', 'mcp:service', 'technical'))
  f.write(document(['U1'], ['bob@example.test']))
  loader.reload()
  assert.equal(store.run(waiting.runId).state, 'interrupted')
  assert.equal(store.run(active.runId).state, 'running')
  assert.equal(store.run(service.runId).state, 'queued')
  await assert.rejects(() => core.submit(mcp('oauth-denied', 'mcp:alice', 'oauth')), /autorizada/)
  controllers[0].finish()
  await until(() => controllers.length === 2)
  assert.equal(controllers[1].options.runId, service.runId)
  controllers[1].finish()
  await until(() => core.active.size === 0)
})
