/**
 * Structural checks that do not need a live browser:
 *  - every page op handled by background.js exists in page-functions.js
 *  - every host-side command string has a case in the extension switch
 *  - snapshots are built from an in-memory ref map (no DOM attributes)
 *  - manifest declares the permissions the code relies on
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(join(root, file), 'utf8')

const toolsSrc = read('lib/tools.js')
const bgSrc = read('extension/background.js')
const pageSrc = read('extension/page-functions.js')
const manifest = JSON.parse(read('extension/manifest.json'))

const failures = []
const pass = (message) => console.log(`PASS ${message}`)
const fail = (message) => {
  failures.push(message)
  console.log(`FAIL ${message}`)
}

// 1. host -> extension command coverage
const sent = new Set()
for (const match of toolsSrc.matchAll(/\b(?:command|mutate)\(\s*(?:exec,\s*args,\s*)?['"]([a-zA-Z.]+)['"]/g)) sent.add(match[1])
const cases = new Set()
for (const match of bgSrc.matchAll(/case '([a-zA-Z.]+)':/g)) cases.add(match[1])
const unhandled = [...sent].filter((name) => !cases.has(name))
if (unhandled.length === 0) pass(`宿主命令全部有扩展处理（${sent.size} 个）`)
else fail(`扩展缺少处理：${unhandled.join(', ')}`)

// 2. extension -> page op coverage
const definedOps = new Set()
for (const match of pageSrc.matchAll(/if \(op === '([a-zA-Z]+)'\)/g)) definedOps.add(match[1])
definedOps.add('waitCheck') // returned from the shared branch below
const calledOps = new Set()
for (const match of bgSrc.matchAll(/execPage\(\s*tab,\s*'([a-zA-Z]+)'/g)) calledOps.add(match[1])
for (const match of bgSrc.matchAll(/execInFrame\(tab,\s*[^,]+,\s*'([a-zA-Z]+)'/g)) calledOps.add(match[1])
const undefinedOps = [...calledOps].filter((name) => !definedOps.has(name))
if (undefinedOps.length === 0) pass(`页面操作全部有实现（${calledOps.size} 个被调用）`)
else fail(`page-functions 缺少实现：${undefinedOps.join(', ')}`)

// 3. refs must live outside the DOM
if (/state\.refs\.set\(/.test(pageSrc) && !/setAttribute\(\s*REF/.test(pageSrc)) {
  pass('引用存在内存 Map，不写 DOM 属性')
} else {
  fail('引用仍可能写入 DOM 属性')
}

// 4. visibility hardening
for (const [label, pattern] of [
  ['opacity', /Number\(style\.opacity\) === 0/],
  ['pointer-events', /pointerEvents === 'none'/],
  ['aria-hidden', /aria-hidden'\) === 'true'/],
  ['inert', /hasAttribute\('inert'\)/],
  ['hidden', /hasAttribute\('hidden'\)/],
]) {
  if (pattern.test(pageSrc)) pass(`可见性过滤包含 ${label}`)
  else fail(`可见性过滤缺少 ${label}`)
}

// 5. trust path
if (/Input\.dispatchMouseEvent/.test(bgSrc) && /Input\.insertText/.test(bgSrc)) pass('存在 CDP 可信输入路径')
else fail('缺少 CDP 可信输入路径')
if (manifest.permissions.includes('debugger')) pass('manifest 声明 debugger 权限')
else fail('manifest 缺少 debugger 权限')
if (manifest.permissions.includes('webNavigation')) pass('manifest 声明 webNavigation 权限')
else fail('manifest 缺少 webNavigation 权限')

// 6. error codes
for (const code of ['element_not_found', 'ref_stale', 'element_occluded']) {
  if (pageSrc.includes(code) || bgSrc.includes(code)) pass(`错误码 ${code} 已实现`)
  else fail(`错误码 ${code} 缺失`)
}

// 7. screenshot evidence on failure
if (/withEvidence/.test(toolsSrc) && /失败现场截图/.test(toolsSrc)) pass('失败时附带截图证据')
else fail('失败时没有截图证据')

console.log(failures.length === 0 ? '\n全部结构检查通过' : `\n失败 ${failures.length} 项`)
process.exit(failures.length === 0 ? 0 : 1)
