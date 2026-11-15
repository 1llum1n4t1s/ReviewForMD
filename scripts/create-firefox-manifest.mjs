import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const [sourceArgument, outputArgument] = process.argv.slice(2)

if (!sourceArgument || !outputArgument) {
  throw new Error("Usage: bun scripts/create-firefox-manifest.mjs <source> <output>")
}

const sourcePath = resolve(sourceArgument)
const outputPath = resolve(outputArgument)
const manifest = JSON.parse(await readFile(sourcePath, "utf8"))

if (manifest.manifest_version !== 3) {
  throw new Error("Chrome manifest must use Manifest V3")
}

const background = manifest.background ?? {}
const serviceWorker = background.service_worker
if (typeof serviceWorker !== "string" || !serviceWorker) {
  throw new Error("Chrome manifest must define background.service_worker")
}
if ("scripts" in background) {
  throw new Error("Chrome Manifest V3 must not contain background.scripts")
}

// 多言語化: ui-localizer.js を background より先に読み込む。Chrome の service worker は
// service_worker.js 内の importScripts で読むが、Firefox の background.scripts には
// importScripts が無いため、scripts の先頭へ置いて同じ Localizer を共有する。
const LOCALIZER_SCRIPT = "src/shared/ui-localizer.js"
if (manifest.default_locale !== "en") {
  throw new Error('Chrome manifest must define "default_locale": "en"')
}
for (const field of ["name", "description"]) {
  if (typeof manifest[field] !== "string" || !/^__MSG_[A-Za-z0-9_@]+__$/.test(manifest[field])) {
    throw new Error(`Chrome manifest "${field}" must be a __MSG_*__ reference`)
  }
}

const { service_worker: _serviceWorker, ...sharedBackground } = background
manifest.background = {
  ...sharedBackground,
  scripts: [LOCALIZER_SCRIPT, serviceWorker],
}
delete manifest.minimum_chrome_version

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

console.log(`Firefox manifest: ${outputPath}`)
