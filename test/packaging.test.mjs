import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createSystemPrompt } from '../src/execution/prompt.ts'

test('plugin artifact is versioned, reproducible and limited to its five public files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-package-'))

  try {
    for (const name of [
      'scripts/package-client-plugin.py',
      'LICENSE',
      'plugins/regent/.claude-plugin/plugin.json',
      'plugins/regent/skills/regent/SKILL.md',
      'plugins/regent/README.md',
    ]) {
      const dest = path.join(directory, name)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(name, dest)
    }

    fs.writeFileSync(
      path.join(directory, 'plugins/regent/private.env'),
      'secret=fixture-must-never-ship',
    )
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, 'plugins/regent/.claude-plugin/plugin.json')),
    )
    const args = [
      'scripts/package-client-plugin.py',
      '--endpoint',
      'https://regent.example.org/mcp',
    ]

    execFileSync('python3', args, { cwd: directory })
    const archive = path.join(directory, 'dist/plugins', `${manifest.name}-${manifest.version}.zip`)
    const first = fs.readFileSync(archive)
    execFileSync('python3', args, { cwd: directory })
    assert.deepEqual(fs.readFileSync(archive), first)
    assert.equal(
      fs.readFileSync(archive + '.sha256', 'utf8').trim(),
      `${createHash('sha256').update(first).digest('hex')}  ${path.basename(archive)}`,
    )
    const bundle = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          'import zipfile,json,sys;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))',
          archive,
        ],
        { encoding: 'utf8' },
      ),
    )

    assert.deepEqual(
      Object.keys(bundle).sort(),
      ['.claude-plugin/plugin.json', '.mcp.json', 'LICENSE', 'README.md', 'skills/regent/SKILL.md']
        .map((n) => `${manifest.name}/${n}`)
        .sort(),
    )
    assert.equal(
      JSON.parse(bundle[`${manifest.name}/.mcp.json`]).mcpServers.regent.url,
      'https://regent.example.org/mcp',
    )
    assert.doesNotMatch(JSON.stringify(bundle), /fixture-must-never-ship/)

    for (const endpoint of [
      'http://regent.example.org/mcp',
      'https://localhost/mcp',
      'https://user:password@regent.example.org/mcp',
      'https://regent.example.org/mcp?token=fixture',
      '${user_config.endpoint}',
    ]) {
      assert.notEqual(
        spawnSync('python3', [args[0], '--endpoint', endpoint], { cwd: directory }).status,
        0,
      )
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('default prompt resources work without private instance configuration', () => {
  const prompt = createSystemPrompt()

  try {
    assert.match(fs.readFileSync(prompt.file, 'utf8'), /Instance Communication/)
    assert.equal(fs.statSync(prompt.file).mode & 0o777, 0o600)
  } finally {
    prompt.dispose()
  }

  assert.equal(fs.existsSync(prompt.file), false)
})
