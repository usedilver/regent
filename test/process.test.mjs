import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { inspectProcess } from '../src/core/process.ts'

test('worktree process inspection identifies a live group and forgets it after exit', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-process-')))
  const child = spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], {
    cwd: directory,
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  try {
    await once(child.stdout, 'data')
    const info = inspectProcess(child.pid)
    assert.equal(info.cwd, directory)
    assert.equal(info.group, child.pid)
    assert.ok(info.start)
    assert.deepEqual(inspectProcess(child.pid), info)
    const exited = once(child, 'exit')
    child.kill()
    await exited
    assert.equal(inspectProcess(child.pid), null)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
