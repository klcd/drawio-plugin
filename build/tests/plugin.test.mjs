// Fast, self-contained checks for the plugin package and all manifest assets.
import assert from 'node:assert/strict'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const manifestPath = resolve(root, 'orca-plugin.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

assert.equal(manifest.manifestVersion, 2)
assert.match(manifest.id, /^[a-z][a-z0-9-]*$/)
assert.match(manifest.publisher, /^[a-zA-Z0-9][a-zA-Z0-9-]*$/)
assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
assert.equal(manifest.execution, 'sandboxed-ui')
assert.ok(Array.isArray(manifest.capabilities))

const assetPaths = new Set([
  manifest.icon,
  manifest.cover?.path,
  ...manifest.screenshots.map(screenshot => screenshot.path),
  ...manifest.contributes.customEditors.flatMap(editor => [editor.entry, editor.icon]),
  ...manifest.contributes.newFiles.flatMap(file => [file.template, file.icon])
].filter(Boolean))

const staysInsideRoot = target => {
  const pathFromRoot = relative(root, target)
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`)
}

const resolveAsset = assetPath => {
  assert.equal(typeof assetPath, 'string')
  assert.ok(assetPath.length > 0, 'asset path must not be empty')
  assert.ok(!isAbsolute(assetPath), `${assetPath} must be relative to the plugin root`)
  assert.ok(!assetPath.includes('\\'), `${assetPath} must use forward slashes`)
  const target = resolve(root, assetPath)
  assert.ok(staysInsideRoot(target), `${assetPath} escapes the plugin root`)
  const stat = lstatSync(target)
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${assetPath} must be a regular file`)
  assert.ok(stat.size > 0, `${assetPath} must not be empty`)
  return target
}

for (const assetPath of assetPaths) resolveAsset(assetPath)

const editorIds = manifest.contributes.customEditors.map(editor => editor.id)
assert.equal(new Set(editorIds).size, editorIds.length, 'custom editor IDs must be unique')
for (const editor of manifest.contributes.customEditors) {
  assert.equal(editor.frame, 'isolated')
  assert.ok(editor.extensions.length > 0)
  assert.equal(new Set(editor.extensions).size, editor.extensions.length)
  for (const extension of editor.extensions) assert.match(extension, /^\.[a-z0-9.]+$/)

  const entryPath = resolveAsset(editor.entry)
  const html = readFileSync(entryPath, 'utf8')
  assert.ok(Buffer.byteLength(html) <= 10 * 1024 * 1024, `${editor.entry} exceeds 10 MB`)
  assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["'](?:https?:|\/\/)/i,
    `${editor.entry} must not load remote resources`)
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const resource = match[1]
    assert.ok(!isAbsolute(resource), `${resource} in ${editor.entry} must be relative`)
    const resourcePath = resolve(dirname(entryPath), resource)
    assert.ok(staysInsideRoot(resourcePath), `${resource} escapes the plugin root`)
    const stat = lstatSync(resourcePath)
    assert.ok(stat.isFile() && stat.size > 0, `${resource} referenced by ${editor.entry} is missing or empty`)
  }
}

for (const newFile of manifest.contributes.newFiles) {
  assert.match(newFile.extension, /^\.[a-z0-9.]+$/)
  const template = readFileSync(resolveAsset(newFile.template), 'utf8')
  assert.match(template, /^\s*<mxfile\b/)
  assert.match(template, /<mxGraphModel\b/)
}

console.log(`PASS: manifest and ${assetPaths.size} declared plugin assets are valid`)
