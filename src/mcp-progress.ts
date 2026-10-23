import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export const PROGRESS_URI = 'ui://regent/progress.html'
let script: string | undefined

export function progressHtml(title = 'Regent') {
  script ??= buildSync({
    entryPoints: [fileURLToPath(new URL('./mcp-progress-app.ts', import.meta.url))],
    bundle: true,
    write: false,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  }).outputFiles[0].text
  const heading = title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;color:var(--color-text-primary,light-dark(#242424,#eee))}
body{margin:0;padding:16px;background:var(--color-background-primary,transparent)}
header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:15px;margin:0;font-weight:600}
small,#connection{color:var(--color-text-secondary,light-dark(#707070,#aaa));font-size:12px}#connection{min-height:18px;margin:8px 0}
ul{padding:0;margin:12px 0;list-style:none}li{display:flex;gap:10px;padding:10px 0;border-top:1px solid var(--color-border-primary,light-dark(#e8e8e8,#333))}
.icon{flex:0 0 18px;color:#7d68cb}.complete{color:light-dark(#3b7a54,#8fc9a4)}.error{color:light-dark(#b1483f,#eb9d95)}
.title{font-weight:500;overflow-wrap:anywhere}.detail{white-space:pre-line;font-size:12px;color:var(--color-text-secondary,light-dark(#707070,#aaa))}
pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}button{font:inherit;color:inherit;background:transparent;border:1px solid var(--color-border-primary,#aaa);border-radius:6px;padding:5px 10px;cursor:pointer}
</style></head><body><header><h2 id="heading">${heading}</h2><button id="refresh" type="button">Actualizar</button></header>
<small id="repo"></small><p id="connection" role="status">Conectando con el trabajo…</p><ul id="activities"></ul>
<pre id="question"></pre><pre id="result"></pre><script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
}

export function registerProgressResource(server: McpServer, title = 'Regent') {
  registerAppResource(
    server,
    `Progreso de ${title}`,
    PROGRESS_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: PROGRESS_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: progressHtml(title),
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
        },
      ],
    }),
  )
}
