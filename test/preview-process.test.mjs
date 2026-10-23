import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Store } from '../src/storage/store.ts'
import { Previews } from '../src/previews/manager.ts'

test('preview publication and routing require the listener to belong to the authorized process group', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-listener-')))
  const store = new Store(':memory:')
  const server = http.createServer((request, response) => response.end('foreign app'))
  const children = []
  let previews
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    previews = new Previews(store, {
      domain: 'preview.example.invalid',
      port_min: port,
      port_max: port,
      ttl_minutes: 5,
      max_active: 1,
    })
    await previews.reserve('fixture', directory)
    const idle = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: directory,
      detached: true,
      stdio: 'ignore',
    })
    children.push(idle)
    await once(idle, 'spawn')
    server.listen(port, '127.0.0.1')
    await once(server, 'listening')
    await assert.rejects(previews.publish('fixture', idle.pid), /listener/)
    await new Promise((resolve) => server.close(resolve))
    const app = spawn(
      process.execPath,
      [
        '-e',
        `const code=${JSON.stringify(`const server=require('node:http').createServer((q,r)=>r.end('owned'));server.listen(${port},'127.0.0.1',()=>console.log('ready'));process.stdin.once('data',()=>server.close(()=>console.log('closed')));setInterval(()=>{},1000)`)};const child=require('node:child_process').spawn(process.execPath,['-e',code],{stdio:['pipe','pipe','inherit']});child.stdout.pipe(process.stdout);process.stdin.pipe(child.stdin);setInterval(()=>{},1000)`,
      ],
      { cwd: directory, detached: true, stdio: ['pipe', 'pipe', 'inherit'] },
    )
    children.push(app)
    await once(app.stdout, 'data')
    const published = await previews.publish('fixture', app.pid)
    assert.equal(published.ready, true)
    const host = new URL(published.url).hostname
    assert.ok(previews.resolve(host))
    const closed = once(app.stdout, 'data')
    app.stdin.write('close')
    await closed
    assert.equal(app.exitCode, null)
    assert.equal(previews.ownsProcess(previews.get('fixture')), true)
    server.listen(port, '127.0.0.1')
    await once(server, 'listening')
    assert.equal(previews.resolve(host), undefined)
    assert.equal(previews.result(previews.get('fixture')).ready, false)
    assert.equal(previews.get('fixture').pid, app.pid)
  } finally {
    previews?.close()
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const exited = once(child, 'exit')
      process.kill(-child.pid, 'SIGTERM')
      await exited
    }
    if (server.listening) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
