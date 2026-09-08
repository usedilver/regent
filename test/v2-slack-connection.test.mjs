import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { SlackConnection } from '../src/v2/slack-connection.ts'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(5) }
  throw new Error('Timed out')
}
const client = new EventEmitter()
let calls = 0, active = 0, maximum = 0, release
client.start = async () => {
  calls++; active++; maximum = Math.max(maximum, active)
  try {
    if (calls <= 2) throw new Error('slack_webapi_request_error: timeout')
    if (calls === 4) await new Promise(resolve => { release = resolve })
    client.emit('connected')
  } finally { active-- }
}
const logs = []
const connection = new SlackConnection(client, message => logs.push(message), 5)
assert.equal(client.autoReconnectEnabled, false)
await connection.start(async () => { client.emit('connected') })
assert.equal(connection.connected, true)
client.emit('disconnected')
client.emit('disconnected')
assert.equal(connection.connected, false)
await until(() => connection.connected)
assert.equal(calls, 3)
assert.equal(maximum, 1)
assert.equal(logs.filter(message => message.includes('No se pudo')).length, 2)

// Shutdown drains an in-flight reconnect, and a late connected event cannot
// revive health or create a new retry after the socket has been stopped.
client.emit('disconnected')
await until(() => release)
let stopped = false
const stopping = connection.stop(async () => { stopped = true; client.emit('disconnected') })
release()
await stopping
assert.equal(stopped, true)
assert.equal(connection.connected, false)
await wait(40)
assert.equal(calls, 4)

const initial = new SlackConnection(new EventEmitter(), () => {}, 5)
await assert.rejects(initial.start(async () => { throw new Error('invalid_auth') }), /invalid_auth/)
assert.equal(initial.connected, false)
await initial.stop(async () => {})

const queuedClient = new EventEmitter()
let queuedCalls = 0
queuedClient.start = async () => { queuedCalls++ }
const queued = new SlackConnection(queuedClient, () => {}, 5)
await queued.start(async () => { queuedClient.emit('connected') })
queuedClient.emit('disconnected')
await queued.stop(async () => {})
await wait(30)
assert.equal(queuedCalls, 0)

// Exercise the installed SDK's apps.connections.open rejection without
// contacting Slack or using credentials.
const require = createRequire(import.meta.url)
const boltRequire = createRequire(require.resolve('@slack/bolt'))
const { SocketModeClient } = boltRequire('@slack/socket-mode')
let requests = 0
const sdk = new SocketModeClient({ appToken: 'test-only', logLevel: 'error',
  clientOptions: { retryConfig: { retries: 0 }, fetch: async () => {
    requests++
    throw new Error('simulated network timeout')
  } } })
const sdkLogs = []
const supervised = new SlackConnection(sdk, message => sdkLogs.push(message), 5)
await supervised.start(async () => { sdk.emit('connected') })
sdk.emit('close')
await until(() => sdkLogs.filter(message => message.includes('No se pudo')).length >= 2)
await supervised.stop(() => sdk.disconnect())
assert.ok(requests >= 2)
assert.equal(supervised.connected, false)
console.log('v2 Slack connection tests passed')
