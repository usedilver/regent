const { fork } = require('node:child_process')
const path = require('node:path')
const messages = []
const child = fork(path.join(__dirname, 'worker-ipc-fixture.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
child.on('message', message => messages.push(message))
child.on('exit', code => console.log(JSON.stringify({ type: 'result', is_error: code !== 0,
  result: JSON.stringify({ messages, watch: process.env.WATCH_REPORT_DEPENDENCIES ?? null, own: process.env.REPO_TEST_VALUE }) })))
