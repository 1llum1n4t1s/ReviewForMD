import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const [sourceArgument, outputArgument] = process.argv.slice(2)

if (!sourceArgument || !outputArgument) {
  throw new Error("Usage: node scripts/create-firefox-manifest.mjs <source> <output>")
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

const { service_worker: _serviceWorker, ...sharedBackground } = background
manifest.background = {
  ...sharedBackground,
  scripts: [serviceWorker],
}
delete manifest.minimum_chrome_version

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

console.log(`Firefox manifest: ${outputPath}`)
