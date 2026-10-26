import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

test('core and storage do not depend on transport adapters or their SDKs', () => {
  for (const dir of ['src/core', 'src/storage']) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue
      const file = path.join(dir, name)
      const source = fs.readFileSync(file, 'utf8')

      for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)) {
        assert.doesNotMatch(
          match[2],
          /(?:^@slack\/|^@modelcontextprotocol\/|(?:^|\/)adapters\/)/,
          file,
        )
      }
    }
  }
})
