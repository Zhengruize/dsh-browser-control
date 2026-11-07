/**
 * End-to-end self test for dsh-browser-control.
 *
 * - starts the plugin with a mock Cordis context (same register/apply contract)
 * - serves test pages over local HTTP
 * - launches Edge/Chrome with the bundled extension loaded
 * - waits until the extension connects to the plugin bridge
 * - exercises every browser_* tool against the test page
 *
 * Run with: node scripts/selftest.mjs
 */
import http from 'node:http'
import { existsSync, openSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, Config } from '../lib/index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TEST_DIR = join(ROOT, 'test')
const EXTENSION_DIR = join(ROOT, 'extension')
const HTTP_PORT = 18080
// Use a port the real DSH install does not occupy, so a running DSH instance
// cannot capture the test extension's connection.
const WS_PORT = Number(process.env.DSH_SELFTEST_WS_PORT) || 17399
const TOKEN = 'selftest-token'
const SHOT_DIR = join(tmpdir(), 'dsh-browser-selftest-shots')

/**
 * The shipped extension defaults to port 17373; for the self test we copy it and
 * rewrite the default settings so it connects to the test bridge instead.
 */
async function prepareExtensionCopy() {
  const target = await mkdtemp(join(tmpdir(), 'dsh-selftest-ext-'))
  await cp(EXTENSION_DIR, target, { recursive: true })
  const bgPath = join(target, 'background.js')
  const source = await readFile(bgPath, 'utf8')
  const patched = source
    .replace(/serverUrl:\s*'ws:\/\/127\.0\.0\.1:\d+'/, `serverUrl: 'ws://127.0.0.1:${WS_PORT}'`)
    .replace(/token:\s*'[^']*'/, `token: '${TOKEN}'`)
  if (patched === source) throw new Error('无法改写扩展副本的默认服务器地址')
  await writeFile(bgPath, patched, 'utf8')
  return target
}

const results = []
let failures = 0

function pass(message) {
  results.push(`PASS  ${message}`)
  console.log(`PASS  ${message}`)
}

function fail(message, error) {
  failures += 1
  results.push(`FAIL  ${message}: ${error instanceof Error ? error.stack : String(error)}`)
  console.error(`FAIL  ${message}:`, error)
}

function check(condition, message) {
  if (!condition) throw new Error(message)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
}

function startHttpServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${HTTP_PORT}`)
      const rel = url.pathname === '/' ? '/test-page.html' : url.pathname
      const filePath = join(TEST_DIR, rel.replace(/^\/+/, ''))
      if (!filePath.startsWith(TEST_DIR)) {
        response.writeHead(403)
        response.end('forbidden')
        return
      }
      const body = await readFile(filePath)
      response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' })
      response.end(body)
    } catch (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`not found: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server))
  })
}

function findBrowser() {
  const candidates = [
    process.env.DSH_SELFTEST_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('没有找到 Edge/Chrome。可用 DSH_SELFTEST_BROWSER 环境变量指定浏览器路径。')
}

function launchBrowser(exe, profileDir, headless, extensionDir = EXTENSION_DIR) {
  const args = [
    ...(headless === 'new' ? ['--headless=new'] : headless === 'old' ? ['--headless'] : []),
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--window-size=1280,900',
    `--user-data-dir=${profileDir}`,
    // Chrome 137+ ignores --load-extension unless this feature is disabled.
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--enable-logging=stderr',
    '--v=0',
    'about:blank',
  ]
  if (headless === 'headed') {
    args.splice(0, 0, '--window-position=-2400,-2400')
  }
  const logPath = join(tmpdir(), `dsh-selftest-browser-${headless}.log`)
  const fd = openSync(logPath, 'w')
  const child = spawn(exe, args, { stdio: ['ignore', fd, fd], windowsHide: true })
  child.logPath = logPath
  child.on('error', (error) => console.error('browser spawn error:', error))
  return child
}

async function printBrowserLog(child) {
  if (!child?.logPath) return
  try {
    const text = await readFile(child.logPath, 'utf8')
    console.warn(`--- browser log (${child.logPath}) ---\n${text.slice(-4000)}`)
  } catch {}
}

function killBrowser(child) {
  if (!child || child.pid === undefined) return
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {}
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await sleep(250)
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`)
}

async function main() {
  const tools = new Map()
  const sections = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get(name) {
        return tools.get(name)
      },
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition)
        return () => {}
      },
    },
    effect(callback) {
      return callback()
    },
    logger(name) {
      return { info: (...args) => console.log(`[${name}]`, ...args) }
    },
  }

  apply(ctx, {
    port: WS_PORT,
    token: TOKEN,
    commandTimeoutMs: 25000,
    screenshotDir: SHOT_DIR,
    allowEval: true,
  })

  async function call(name, args = {}) {
    const definition = tools.get(name)
    check(definition !== undefined, `工具未注册：${name}`)
    const value = await definition.execute(args, { signal: new AbortController().signal })
    const violations = validateJsonSchemaValue(definition.output.schema, value)
    check(violations.length === 0, `${name} 输出不满足 schema：${violations.join('; ')}`)
    const content = definition.output.render(args, value)
    check(Array.isArray(content) && content.length > 0, `${name} render 未返回内容`)
    return { value, content }
  }

  const expectedTools = [
    'browser_status',
    'browser_tabs',
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_hover',
    'browser_select',
    'browser_type',
    'browser_press_key',
    'browser_scroll',
    'browser_drag',
    'browser_extract',
    'browser_screenshot',
    'browser_eval',
    'browser_wait',
  ]
  for (const name of expectedTools) check(tools.has(name), `缺少工具 ${name}`)
  pass(`注册了 ${expectedTools.length} 个 browser_* 工具`)
  check(sections.length === 1, '未注册 system prompt 引导段')
  pass('注册了 system prompt 引导段')

  const disconnected = await call('browser_status')
  check(disconnected.value.connected === false, '扩展尚未连接时 browser_status 应报告未连接')
  let offlineError
  try {
    await call('browser_navigate', { url: 'https://example.com' })
  } catch (error) {
    offlineError = error
  }
  check(offlineError !== undefined && /未连接/.test(offlineError.message), '扩展未连接时导航应给出可读错误')
  pass('扩展未连接时给出可读错误')

  const httpServer = await startHttpServer()
  pass(`测试页面服务已启动：http://127.0.0.1:${HTTP_PORT}/`)

  const exe = findBrowser()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-browser-selftest-'))
  const testExtensionDir = await prepareExtensionCopy()
  let browser
  let connected = false
  try {
    for (const mode of ['new', 'old', 'headed']) {
      browser = launchBrowser(exe, profileDir, mode, testExtensionDir)
      try {
        await waitFor(async () => {
          try {
            const status = await tools.get('browser_status').execute({}, { signal: new AbortController().signal })
            return status.connected === true
          } catch {
            return false
          }
        }, 20000, `浏览器扩展连接（${mode} 模式）`)
        connected = true
        pass(`浏览器已启动并连接扩展（${mode} 模式）：${exe}`)
        break
      } catch (error) {
        killBrowser(browser)
        await printBrowserLog(browser)
        await sleep(1500)
        console.warn(`启动模式 ${mode} 未连接，重试下一种模式…`)
      }
    }
    check(connected, '浏览器扩展始终没有连接到插件')

    const status = await call('browser_status')
    check(status.value.connected === true, 'browser_status 应显示已连接')
    check(typeof status.value.extension?.version === 'string', '缺少扩展版本')
    pass(`browser_status 已连接，扩展版本 ${status.value.extension.version}`)

    const tabs = await call('browser_tabs', { action: 'list' })
    check(Array.isArray(tabs.value.tabs), 'tabs.list 未返回标签页数组')
    pass(`browser_tabs list 返回 ${tabs.value.tabs.length} 个标签页`)

    const nav = await call('browser_navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` })
    check(nav.value.page?.url.includes('127.0.0.1:18080'), '导航 URL 不正确')
    check(nav.value.page?.title.includes('测试页'), '页面标题不正确')
    pass(`browser_navigate 打开测试页：${nav.value.page.title}`)

    const snap = await call('browser_snapshot', {})
    const elements = snap.value.elements
    check(Array.isArray(elements) && elements.length >= 5, `快照元素过少：${elements?.length}`)
    const nameField = elements.find((el) => el.id === 'name' || el.name === 'name')
    const greetButton = elements.find((el) => el.id === 'greet')
    check(nameField !== undefined, `快照缺少 #name 输入框（实际元素：${elements.map((el) => el.selector).join(', ')}）`)
    check(greetButton !== undefined, '快照缺少 #greet 按钮')
    check(typeof nameField.ref === 'string' && nameField.ref.length > 0, '快照元素缺少 ref')
    pass(`browser_snapshot 返回 ${elements.length} 个元素（refs 可用）`)

    const typed = await call('browser_type', { ref: nameField.ref, text: 'Alice' })
    check(typed.value.value === 'Alice', `输入框值不符：${JSON.stringify(typed.value.value)}`)
    pass('browser_type 成功输入文本')

    const clicked = await call('browser_click', { ref: greetButton.ref })
    check(clicked.value.element?.ref === greetButton.ref, '点击结果缺少元素信息')
    pass('browser_click 成功点击按钮')

    const waited = await call('browser_wait', { text: 'Hello, Alice!', timeoutMs: 5000 })
    check(waited.value.matched === true, 'browser_wait 未等到文本')
    pass('browser_wait 等到动态文本')

    const extracted = await call('browser_extract', { format: 'markdown' })
    check(extracted.value.content.includes('测试页'), 'markdown 提取缺少标题')
    check(extracted.value.content.includes('Hello, Alice!'), 'markdown 提取缺少输出文本')
    pass(`browser_extract markdown 成功（${extracted.value.content.length} 字符）`)

    const links = await call('browser_extract', { format: 'links' })
    check(links.value.content.includes('page2.html'), 'links 提取缺少第二页链接')
    pass('browser_extract links 成功')

    const evaluated = await call('browser_eval', { expression: "document.querySelector('#name').value" })
    check(evaluated.value.result === 'Alice', `browser_eval 结果不符：${JSON.stringify(evaluated.value.result)}`)
    pass('browser_eval 读取页面状态')

    // A ref must fail with ref_stale once its element is removed from the DOM.
    await call('browser_eval', {
      expression:
        "(() => { const b=document.createElement('button'); b.id='doomed'; b.textContent='临时按钮'; b.style.cssText='position:fixed;left:8px;top:8px;z-index:9999'; document.body.appendChild(b); return true })()",
    })
    const staleSnap = await call('browser_snapshot', {})
    const doomed = (staleSnap.value.elements ?? []).find((el) => el.text === '临时按钮')
    check(doomed !== undefined, '快照未包含临时按钮')
    await call('browser_eval', { expression: "document.getElementById('doomed')?.remove(); !document.getElementById('doomed')" })
    const stillThere = await call('browser_eval', { expression: "document.body.innerText.includes('临时按钮')" })
    check(stillThere.value.result === false, '临时按钮没有真正从页面移除')
    let staleError
    let staleResult
    try {
      staleResult = await call('browser_click', { ref: doomed.ref })
    } catch (error) {
      staleError = error
    }
    check(staleError !== undefined, `已移除元素的引用本应失效（ref=${doomed.ref}，结果=${JSON.stringify(staleResult?.value)}）`)
    check(/ref_stale/.test(staleError.message), `过期引用未返回 ref_stale：${staleError.message}`)
    pass('过期引用返回 ref_stale 错误码')

    // Native <select> path.
    const selectSnap = await call('browser_snapshot', {})
    const topicSelect = selectSnap.value.elements.find((el) => el.id === 'topic' || el.name === 'topic')
    check(topicSelect !== undefined, `快照缺少 #topic 下拉框（元素：${(selectSnap.value.elements ?? []).map((el) => el.selector).join(', ')}）`)
    const selected = await call('browser_select', { ref: topicSelect.ref, label: '主题 B' })
    check(selected.value.selected?.value === 'b' || selected.value.selected?.label === '主题 B', `下拉框选择失败：${JSON.stringify(selected.value.selected)}`)
    pass('browser_select 选中原生下拉框选项')

    // Hover dispatch.
    const hovered = await call('browser_hover', { selector: '#greet' })
    check(hovered.value.hovered === true, 'browser_hover 未返回成功')
    pass('browser_hover 派发悬停事件')

    // Scroll an element into view.
    const scrolledTo = await call('browser_scroll', { toSelector: '#bottom-button' })
    check(scrolledTo.value.inViewport === true, 'browser_scroll 未能把底部按钮滚进视口')
    pass('browser_scroll toSelector 滚动到元素')

    // Occlusion detection must refuse to click through an overlay.
    await call('browser_navigate', { url: `http://127.0.0.1:${HTTP_PORT}/complex-page.html` })
    let occluded
    try {
      await call('browser_click', { selector: '#under' })
    } catch (error) {
      occluded = error
    }
    check(occluded !== undefined, '被遮罩盖住的按钮本应拒绝点击')
    check(/element_occluded/.test(occluded.message), `遮挡错误码不正确：${occluded.message}`)
    pass('browser_click 被遮挡时返回 element_occluded')

    // Shadow DOM + iframe reach, on the complex test page.
    const complexSnap = await call('browser_snapshot', {})
    const shadowButton = (complexSnap.value.elements ?? []).find((el) => el.text === 'Shadow 按钮')
    check(shadowButton !== undefined, `快照未穿透 Shadow DOM（元素数 ${complexSnap.value.elements?.length}）`)
    check(shadowButton.inShadow === true, 'Shadow DOM 元素缺少 inShadow 标记')
    pass(`browser_snapshot 穿透 open Shadow DOM（${shadowButton.shadowPath ?? 'shadow'}）`)

    const frameHit = (complexSnap.value.elements ?? []).find((el) => el.text === 'iframe 里的按钮')
    const frames = complexSnap.value.frames ?? []
    check(frames.length >= 1, 'browser_snapshot 未列出子框架')
    const clickedInFrame =
      frameHit !== undefined
        ? await call('browser_click', { ref: frameHit.ref })
        : await call('browser_click', { text: 'iframe 里的按钮' })
    const frameResult = await call('browser_extract', { format: 'text' })
    check(/iframe 按钮被点击了/.test(frameResult.value.content), '没有点击到 iframe 内的按钮')
    pass(`browser_click 进入 iframe（frameId=${clickedInFrame.value.page?.frameId ?? 'auto'}）`)

    // Visibility hardening: hidden/transparent controls must be clickable-by-request only.
    const hiddenProbe = await call('browser_eval', { expression: "(() => { const d=document.createElement('button'); d.id='ghost'; d.textContent='幽灵按钮'; d.style.cssText='opacity:0;position:fixed;left:10px;top:10px;z-index:9999'; document.body.appendChild(d); return true })()" })
    check(hiddenProbe.value.result === true, '无法注入隐藏元素')
    const afterGhost = await call('browser_snapshot', {})
    const ghost = (afterGhost.value.elements ?? []).find((el) => el.text === '幽灵按钮')
    check(ghost === undefined, 'opacity:0 的元素仍出现在快照中')
    pass('opacity:0 的元素被可见性过滤排除')

    await call('browser_navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` })

    const delayed = await call('browser_wait', { selector: '#delayed', state: 'visible', timeoutMs: 5000 })
    check(delayed.value.matched === true, '未等到延迟元素可见')
    pass('browser_wait 等到延迟加载元素')

    await call('browser_scroll', { direction: 'bottom' })
    const scrolled = await call('browser_eval', { expression: 'window.scrollY' })
    check(Number(scrolled.value.result) > 100, `页面未滚动：${scrolled.value.result}`)
    pass('browser_scroll 滚动到底部')

    await call('browser_scroll', { direction: 'top' })

    const shot = await call('browser_screenshot', {})
    const shotStat = await stat(shot.value.path)
    check(shotStat.size > 1000, '截图文件过小')
    check(Number(shot.value.width) > 0 && Number(shot.value.height) > 0, '截图尺寸无效')
    pass(`browser_screenshot 保存 ${shot.value.width}x${shot.value.height} PNG（${shotStat.size} 字节）`)

    const pressed = await call('browser_press_key', { key: 'Escape' })
    check(pressed.value.key === 'Escape', 'pressKey 未返回按键')
    pass('browser_press_key 成功派发按键')

    const opened = await call('browser_tabs', { action: 'open', url: `http://127.0.0.1:${HTTP_PORT}/page2.html` })
    check(opened.value.tab?.url.includes('page2.html'), 'tabs.open 未打开目标页')
    await call('browser_wait', { text: '这是用于验证标签页切换与导航的第二页。', timeoutMs: 5000 })
    const list2 = await call('browser_tabs', { action: 'list' })
    check(list2.value.tabs.length >= 2, '新标签页没有出现在列表中')
    const closed = await call('browser_tabs', { action: 'close', tabId: opened.value.tab.id })
    check(closed.value.closedTabId === opened.value.tab.id, 'tabs.close 返回不一致')
    pass('browser_tabs open/close 成功')

    const finalStatus = await call('browser_status')
    check(finalStatus.value.connected === true, '最终状态应为已连接')
    pass('所有浏览器工具端到端测试通过')
  } finally {
    killBrowser(browser)
    await sleep(800)
    try {
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5 })
    } catch {}
    await rm(SHOT_DIR, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    await new Promise((resolve) => httpServer.close(resolve))
  }

  console.log('\n' + results.join('\n'))
  if (failures > 0) {
    console.error(`\n${failures} 项失败`)
  } else {
    console.log(`\n全部 ${results.length} 项断言通过 ✅`)
  }
}

main()
  .then(() => setTimeout(() => process.exit(failures > 0 ? 1 : 0), 300))
  .catch((error) => {
    console.error('SELFTEST FAILED:', error)
    setTimeout(() => process.exit(1), 300)
  })
