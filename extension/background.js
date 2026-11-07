/**
 * DSH Browser Control — extension service worker.
 *
 * Connects to the dsh-browser-control plugin over a loopback WebSocket and
 * executes the plugin's browser commands in the user's own browser session.
 */
import { pageExec } from './page-functions.js'

const DEFAULT_SETTINGS = {
  serverUrl: 'ws://127.0.0.1:17373',
  // The plugin auto-generates a token into ~/.dsh/.browser-control-token on
  // first start; paste that value here (or set config.token in the plugin).
  token: '',
  autoReconnect: true,
}

const KEEPALIVE_ALARM = 'dsh-browser-keepalive'

let settings = { ...DEFAULT_SETTINGS }
let socket
let state = 'disconnected'
let lastError = ''
let reconnectTimer
let reconnectDelay = 1000
let manualDisconnect = false

const log = (...args) => console.log('[dsh-browser-control]', ...args)

/** In-memory debug trail, readable over CDP while developing. */
const debugTrail = (globalThis.__dshDebug = { state: 'boot', events: [] })
function trace(event, extra) {
  try {
    debugTrail.state = state
    debugTrail.events.push({ t: Date.now(), event, ...(extra === undefined ? {} : { extra: String(extra).slice(0, 300) }) })
    if (debugTrail.events.length > 40) debugTrail.events.shift()
    log(event, extra ?? '')
  } catch {}
}

self.addEventListener('error', (event) => trace('sw-error', event.message))
self.addEventListener('unhandledrejection', (event) => trace('sw-rejection', event.reason?.stack || event.reason))

function detectBrowser() {
  const ua = navigator.userAgent
  if (ua.includes('Edg/')) return 'Microsoft Edge'
  if (ua.includes('OPR/')) return 'Opera'
  if (ua.includes('Chrome/')) return 'Google Chrome'
  return 'Chromium'
}

function platformName() {
  try {
    return navigator.userAgentData?.platform || navigator.platform || 'unknown'
  } catch {
    return 'unknown'
  }
}

function setState(next, error = '') {
  state = next
  lastError = error || lastError
  trace(`state:${next}`, error)
  const badge = next === 'connected' ? 'ON' : next === 'connecting' ? '...' : error ? 'ERR' : ''
  const color = next === 'connected' ? '#188038' : next === 'connecting' ? '#b06000' : '#b3261e'
  try {
    chrome.action.setBadgeText({ text: badge }).catch(() => {})
    chrome.action.setBadgeBackgroundColor({ color }).catch(() => {})
    chrome.action.setTitle({
      title: error ? `DSH Browser Control: ${error}` : `DSH Browser Control: ${next}`,
    }).catch(() => {})
  } catch {}
  try {
    chrome.runtime.sendMessage({ type: 'dsh-browser-state', state: next, error }).catch(() => {})
  } catch {}
}

function statusSnapshot() {
  return {
    state,
    error: lastError,
    settings,
    browser: detectBrowser(),
    version: chrome.runtime.getManifest().version,
    socketUrl: settings.serverUrl,
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS)
  settings = { ...DEFAULT_SETTINGS, ...stored }
}

function scheduleReconnect() {
  if (manualDisconnect || !settings.autoReconnect) return
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 1.6, 30000)
    connect()
  }, reconnectDelay)
}

function connect() {
  manualDisconnect = false
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  clearTimeout(reconnectTimer)
  try {
    socket = new WebSocket(settings.serverUrl)
  } catch (error) {
    setState('error', `服务器地址无效：${error instanceof Error ? error.message : String(error)}`)
    scheduleReconnect()
    return
  }
  setState('connecting')
  trace('connect', settings.serverUrl)
  socket.addEventListener('open', () => {
    trace('open')
    reconnectDelay = 1000
    socket.send(
      JSON.stringify({
        type: 'hello',
        token: settings.token,
        version: chrome.runtime.getManifest().version,
        browser: detectBrowser(),
        platform: platformName(),
      }),
    )
  })
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.type === 'hello-ok') {
      setState('connected', '')
      trace('hello-ok')
      return
    }
    if (message.type === 'hello-error') {
      setState('error', String(message.error || '握手失败'))
      try {
        socket.close()
      } catch {}
      return
    }
    if (message.type === 'ping') {
      try {
        socket.send(JSON.stringify({ type: 'pong', id: message.id }))
      } catch {}
      return
    }
    if (message.type === 'cmd') {
      const { id, name, params } = message
      handleCommand(name, params || {})
        .then((data) => {
          try {
            socket.send(JSON.stringify({ type: 'res', id, ok: true, data }))
          } catch {}
        })
        .catch((error) => {
          trace(`cmd-error:${name}`, error instanceof Error ? error.message : error)
          try {
            socket.send(
              JSON.stringify({
                type: 'res',
                id,
                ok: false,
                error: {
                  message: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                },
              }),
            )
          } catch {}
        })
    }
  })
  socket.addEventListener('close', () => {
    trace('close')
    if (state !== 'error') setState('disconnected')
    socket = undefined
    scheduleReconnect()
  })
  socket.addEventListener('error', () => {
    trace('socket-error')
    setState('error', `无法连接 ${settings.serverUrl}（请确认 DSH 插件已启动，且地址与 token 正确）`)
  })
}

function disconnect() {
  manualDisconnect = true
  clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  if (socket) {
    try {
      socket.close(1000, 'user disconnect')
    } catch {}
    socket = undefined
  }
  setState('disconnected')
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tabs[0]) return tabs[0]
  const fallback = await chrome.tabs.query({ active: true })
  if (fallback[0]) return fallback[0]
  return undefined
}

async function getTab(params) {
  if (params && typeof params.tabId === 'number') {
    try {
      return await chrome.tabs.get(params.tabId)
    } catch {
      throw new Error(`找不到标签页 ${params.tabId}`)
    }
  }
  const tab = await getActiveTab()
  if (!tab) throw new Error('当前没有可用的标签页，请先用 browser_tabs 打开一个页面')
  return tab
}

function tabSummary(tab) {
  if (!tab) return undefined
  return {
    id: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    active: tab.active === true,
    windowId: tab.windowId,
  }
}

function assertScriptable(tab) {
  const url = tab.url || ''
  if (url.startsWith('file://')) {
    throw new Error(
      `扩展默认无法注入 file:// 页面（${url}）。请在 chrome://extensions 打开 DSH Browser Control 的「允许访问文件网址」后重试。`,
    )
  }
  if (
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('devtools://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('https://chromewebstore.google.com') ||
    url.startsWith('https://chrome.google.com/webstore')
  ) {
    throw new Error(`浏览器不允许扩展在此页面注入脚本：${url}。请切换到普通网页后重试。`)
  }
}

const NOT_FOUND_RE = /找不到|not found|cannot find|no such element|没有可用的框架/i

/** Frame ids of a tab ordered so the top frame comes first. */
async function listFrameIds(tab) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id })
    if (!Array.isArray(frames) || frames.length === 0) return [0]
    return frames
      .map((frame) => frame.frameId)
      .sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b))
  } catch {
    return [0]
  }
}

async function execInFrame(tab, frameId, op, params, world) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId] },
    func: pageExec,
    args: [op, params],
    world,
  })
  const first = results && results[0]
  if (!first) throw new Error('页面脚本没有返回结果')
  if (first.error) throw new Error(String(first.error.message || first.error))
  if (first.result === undefined || first.result === null) {
    throw new Error(`页面脚本「${op}」未返回数据：元素可能已从页面移除，或页面在操作期间刷新了`)
  }
  return first.result
}

/**
 * Run a page op. Element ops automatically fall back to child frames when the
 * top frame cannot resolve the element, which makes same-origin and
 * cross-origin iframes usable without extra hand-holding.
 */
async function execPage(tab, op, params = {}, world = 'ISOLATED') {
  assertScriptable(tab)
  const explicitFrame = typeof params.frameId === 'number' ? params.frameId : undefined
  const frameIds = explicitFrame === undefined ? await listFrameIds(tab) : [explicitFrame]
  const payload = { ...params }
  delete payload.frameId
  let lastError
  for (const frameId of frameIds) {
    try {
      const result = await execInFrame(tab, frameId, op, payload, world)
      if (result && typeof result === 'object' && result.page && !result.page.frameId) result.page.frameId = frameId
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastError = error
      if (explicitFrame !== undefined || !NOT_FOUND_RE.test(message)) {
        throw new Error(`在此页面执行操作失败（frame ${frameId}）：${message}`)
      }
    }
  }
  throw new Error(`在此页面执行操作失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * Real (trusted) input path. DOM events dispatched from script can never have
 * isTrusted === true, so pages that check it need the browser's own input
 * pipeline: attach chrome.debugger and use CDP Input.*.
 */
async function withDebugger(tab, fn) {
  const target = { tabId: tab.id }
  try {
    await chrome.debugger.attach(target, '1.3')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/another debugger|already attached/i.test(message)) {
      throw new Error(`标签页已被其他调试器占用（DevTools 或另一扩展），无法执行真实输入：${message}`)
    }
    throw new Error(`无法附加调试器（real 模式需要 debugger 权限）：${message}`)
  }
  try {
    return await fn(target)
  } finally {
    try {
      await chrome.debugger.detach(target)
    } catch {}
  }
}

const cdp = (target, method, params = {}) => chrome.debugger.sendCommand(target, method, params)

/** CDP-backed click: Input.dispatchMouseEvent at the element's center. */
async function realClick(tab, params) {
  const box = await execPage(tab, 'elementBox', {
    ref: params.ref,
    selector: params.selector,
    text: params.text,
    frameId: params.frameId,
  })
  if (!box || !box.point) throw new Error('无法定位元素坐标，无法执行真实点击')
  const frameId = box.page?.frameId
  if (typeof frameId === 'number' && frameId !== 0) {
    throw new Error(
      `real 模式目前只支持主框架（元素位于 frameId=${frameId} 的 iframe 内，CDP 坐标需要框架偏移）。请去掉 real 参数走合成事件，或在主框架内的元素上使用 real。`,
    )
  }
  if (box.hit && box.hit.hit === false && params.force !== true) {
    throw new Error(`[element_occluded] 元素被遮挡，已拒绝真实点击：${box.hit.reason}。请先关闭遮罩或传 force:true。`)
  }
  const { x, y } = box.point
  const button = String(params.button || 'left').toLowerCase()
  const clickCount = Math.max(1, Number(params.clickCount) || 1)
  await withDebugger(tab, async (target) => {
    await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await cdp(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: button === 'right' ? 2 : button === 'middle' ? 4 : 1,
      clickCount,
    })
    await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount })
  })
  await sleep(80)
  const probe = await execPage(tab, 'inputProbe', { frameId: box.page?.frameId })
  return {
    element: box.element,
    point: box.point,
    mode: 'real',
    trusted: probe?.lastInput ? probe.lastInput.isTrusted === true : undefined,
    lastInput: probe?.lastInput ?? null,
    generation: box.generation,
    page: probe?.page ?? box.page,
  }
}

/** CDP-backed typing: focus, optionally clear with Ctrl+A/Backspace, Input.insertText. */
async function realType(tab, params) {
  const focus = await execPage(tab, 'focus', {
    ref: params.ref,
    selector: params.selector,
    frameId: params.frameId,
  })
  const text = String(params.text ?? '')
  await withDebugger(tab, async (target) => {
    if (params.clear !== false) {
      await cdp(target, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        modifiers: 2,
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
      })
      await cdp(target, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        modifiers: 2,
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
      })
      await cdp(target, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      })
      await cdp(target, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      })
    }
    if (text) await cdp(target, 'Input.insertText', { text })
    if (params.pressEnter === true) {
      await cdp(target, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
      await cdp(target, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
    }
  })
  await sleep(80)
  const probe = await execPage(tab, 'inputProbe', { frameId: focus.page?.frameId })
  let value = focus.value
  try {
    const read = await execPage(tab, 'readValue', {
      ref: params.ref,
      selector: params.selector,
      frameId: focus.page?.frameId,
    })
    if (read && typeof read.value === 'string') value = read.value
  } catch {}
  return {
    element: focus.element,
    value,
    mode: 'real',
    trusted: probe?.lastInput ? probe.lastInput.isTrusted === true : undefined,
    lastInput: probe?.lastInput ?? null,
    page: probe?.page ?? focus.page,
  }
}

function waitForTabLoad(tabId, timeoutMs) {  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish()
    }
    const timer = setTimeout(finish, Math.max(1000, timeoutMs || 20000))
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish()
      })
      .catch(finish)
  })
}

async function pageInfoOrTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    const info = await execPage(tab, 'pageInfo')
    return info.page ?? tabSummary(tab)
  } catch {
    try {
      return tabSummary(await chrome.tabs.get(tabId))
    } catch {
      return undefined
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll the top frame until document.readyState reaches interactive/complete. */
async function waitForReadyState(tab, target, timeoutMs) {
  const limit = Math.max(1000, Math.min(Number(timeoutMs) || 20000, 60000))
  const started = Date.now()
  while (Date.now() - started <= limit) {
    try {
      const info = await execInFrame(tab, 0, 'activity', {}, 'ISOLATED')
      const state = info?.readyState
      if (target === 'interactive' ? state === 'interactive' || state === 'complete' : state === 'complete') return true
    } catch {
      /* page still navigating; retry */
    }
    await sleep(100)
  }
  return false
}

/**
 * SPA-friendly "network idle": document complete plus no growth in the resource
 * timing count for a quiet window. This catches XHR/fetch driven renders that
 * finish long after the load event.
 */
async function waitForIdle(tab, timeoutMs) {
  const limit = Math.max(1000, Math.min(Number(timeoutMs) || 10000, 60000))
  const started = Date.now()
  let lastResources = -1
  let quietSince = 0
  let latest
  while (Date.now() - started <= limit) {
    try {
      latest = await execInFrame(tab, 0, 'activity', {}, 'ISOLATED')
      const resources = Number(latest?.resources ?? 0)
      if (latest?.readyState === 'complete' && resources === lastResources) {
        if (quietSince === 0) quietSince = Date.now()
        if (Date.now() - quietSince >= 600) return latest
      } else {
        quietSince = 0
        lastResources = resources
      }
    } catch {
      quietSince = 0
    }
    await sleep(200)
  }
  return latest
}

/** Poll until selector/text reaches the requested state (or timeout). */
async function waitForCondition(tab, params) {
  const timeoutMs = Math.max(500, Math.min(Number(params.timeoutMs) || 15000, 120000))
  const started = Date.now()
  let last
  while (Date.now() - started <= timeoutMs) {
    try {
      last = await execPage(tab, 'waitCheck', {
        selector: params.selector,
        text: params.text,
        state: params.state,
        frameId: params.frameId,
      })
    } catch (error) {
      last = { matched: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (last.matched) return { matched: true, elapsedMs: Date.now() - started, detail: last, page: last.page }
    await sleep(150)
  }
  return { matched: false, elapsedMs: Date.now() - started, detail: last, page: last?.page ?? (await pageInfoOrTab(tab.id)) }
}

async function handleCommand(name, params) {
  switch (name) {
    case 'status': {
      const tab = await getActiveTab()
      const tabs = await chrome.tabs.query({})
      return {
        browser: detectBrowser(),
        platform: platformName(),
        extensionVersion: chrome.runtime.getManifest().version,
        activeTab: tabSummary(tab),
        tabCount: tabs.length,
      }
    }

    case 'tabs.list': {
      const tabs = await chrome.tabs.query({})
      return {
        tabs: tabs.map(tabSummary),
        activeTabId: (await getActiveTab())?.id,
      }
    }

    case 'tabs.open': {
      if (!params.url) throw new Error('tabs.open 需要 url')
      const tab = await chrome.tabs.create({ url: params.url, active: true })
      if (/^https?:/i.test(params.url)) await waitForTabLoad(tab.id, 20000)
      const fresh = await chrome.tabs.get(tab.id)
      return { tab: tabSummary(fresh) }
    }

    case 'tabs.activate': {
      const tab = await getTab(params)
      await chrome.tabs.update(tab.id, { active: true })
      try {
        await chrome.windows.update(tab.windowId, { focused: true })
      } catch {}
      return { tab: tabSummary(await chrome.tabs.get(tab.id)) }
    }

    case 'tabs.close': {
      const tab = await getTab(params)
      const id = tab.id
      await chrome.tabs.remove(id)
      return { closedTabId: id, tabs: (await chrome.tabs.query({})).map(tabSummary) }
    }

    case 'navigate': {
      if (!params.url) throw new Error('navigate 需要 url')
      const tab = await getTab(params)
      await chrome.tabs.update(tab.id, { url: params.url, active: true })
      const timeoutMs = Number(params.timeoutMs) || 20000
      const waitUntil = String(params.waitUntil || 'load')
      if (waitUntil !== 'none') {
        if (waitUntil === 'domcontentloaded') {
          await waitForReadyState(tab, 'interactive', timeoutMs)
        } else {
          await waitForTabLoad(tab.id, timeoutMs)
          if (waitUntil === 'networkidle') await waitForIdle(tab, Math.min(timeoutMs, 15000))
        }
      }
      let waited
      if (params.waitFor) {
        waited = await waitForCondition(tab, {
          selector: params.waitFor,
          state: 'visible',
          timeoutMs: Math.min(timeoutMs, 15000),
          frameId: params.frameId,
        })
      }
      const fresh = await chrome.tabs.get(tab.id)
      return { page: { url: fresh.url, title: fresh.title, readyState: waitUntil }, tab: tabSummary(fresh), waited }
    }

    case 'frames': {
      const tab = await getTab(params)
      assertScriptable(tab)
      let frames
      try {
        frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id })
      } catch (error) {
        throw new Error(`无法枚举框架：${error instanceof Error ? error.message : String(error)}`)
      }
      return {
        tabId: tab.id,
        frames: (frames || []).map((frame) => ({
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          isTop: frame.frameId === 0,
          url: frame.url,
        })),
      }
    }

    case 'snapshot': {
      const tab = await getTab(params)
      const result = (await execPage(tab, 'snapshot', params)) ?? {}
      try {
        const allFrames = await chrome.webNavigation.getAllFrames({ tabId: tab.id })
        const children = (allFrames || []).filter((frame) => frame.frameId !== 0)
        if (children.length > 0) {
          result.frames = children.map((frame) => ({ frameId: frame.frameId, url: frame.url }))
        }
      } catch {
        /* webNavigation unavailable; ignore */
      }
      return result
    }

    case 'click': {
      const tab = await getTab(params)
      if (params.real === true) return await realClick(tab, params)
      return await execPage(tab, 'click', params)
    }

    case 'type': {
      const tab = await getTab(params)
      if (params.real === true) return await realType(tab, params)
      return await execPage(tab, 'type', params)
    }

    case 'scroll': {
      const tab = await getTab(params)
      if (params.untilText) {
        return await execPage(tab, 'scrollFind', {
          text: params.untilText,
          direction: params.direction,
          pixels: params.pixels,
          maxSteps: params.maxSteps,
          ref: params.containerRef ?? params.ref,
          selector: params.containerRef ? undefined : params.containerSelector ?? params.selector,
          frameId: params.frameId,
        })
      }
      if (params.toRef || params.toSelector) {
        return await execPage(tab, 'scrollInto', {
          ref: params.toRef,
          selector: params.toSelector,
          align: params.align,
          frameId: params.frameId,
        })
      }
      return await execPage(tab, 'scroll', params)
    }

    case 'hover':
    case 'select':
    case 'pressKey':
    case 'drag':
    case 'extract':
    case 'waitCheck': {
      const tab = await getTab(params)
      return await execPage(tab, name, params)
    }

    case 'eval': {
      const tab = await getTab(params)
      // Extension CSP forbids eval/new Function in the ISOLATED world, so run in
      // the page's MAIN world where the page's own CSP governs evaluation.
      const requestedWorld = params.world === 'isolated' ? 'ISOLATED' : 'MAIN'
      const args = { expression: params.expression, awaitPromise: params.awaitPromise, frameId: params.frameId }
      try {
        const result = await execPage(tab, 'eval', args, requestedWorld)
        return { ...result, world: requestedWorld === 'MAIN' ? 'main' : 'isolated' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (requestedWorld === 'ISOLATED' && /eval|Content Security Policy|unsafe|EvalError/i.test(message)) {
          const result = await execPage(tab, 'eval', args, 'MAIN')
          return { ...result, world: 'main' }
        }
        throw new Error(`browser_eval 执行失败：${message}`)
      }
    }

    case 'screenshot': {
      const tab = await getTab(params)
      if (tab.active !== true) await chrome.tabs.update(tab.id, { active: true })
      try {
        await chrome.windows.update(tab.windowId, { focused: true })
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 180))
      let dataUrl
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      } catch (error) {
        throw new Error(
          `截图失败：${error instanceof Error ? error.message : String(error)}。常见原因是窗口最小化、标签页在后台，或页面受保护。可改用 browser_extract / browser_snapshot 获取内容。`,
        )
      }
      return { dataUrl, page: await pageInfoOrTab(tab.id) }
    }

    case 'wait': {
      const tab = await getTab(params)
      return await waitForCondition(tab, params)
    }

    default:
      throw new Error(`未知的浏览器命令：${name}`)
  }
}

function ensureKeepaliveAlarm() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
  } catch {
    try {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 })
    } catch {}
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureKeepaliveAlarm()
  loadSettings().then(connect)
})

chrome.runtime.onStartup.addListener(() => {
  ensureKeepaliveAlarm()
  loadSettings().then(connect)
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    if (!manualDisconnect) loadSettings().then(connect)
    return
  }
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: 'ping', from: 'extension' }))
    } catch {}
  }
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false
  if (message.type === 'dsh-browser-popup') {
    ;(async () => {
      if (message.action === 'status') {
        sendResponse(statusSnapshot())
        return
      }
      if (message.action === 'connect') {
        manualDisconnect = false
        await loadSettings()
        connect()
        sendResponse(statusSnapshot())
        return
      }
      if (message.action === 'disconnect') {
        disconnect()
        sendResponse(statusSnapshot())
        return
      }
      if (message.action === 'save') {
        settings = { ...settings, ...(message.settings || {}) }
        await chrome.storage.local.set(settings)
        disconnect()
        manualDisconnect = false
        connect()
        sendResponse(statusSnapshot())
        return
      }
      sendResponse(statusSnapshot())
    })().catch((error) => sendResponse({ ...statusSnapshot(), error: String(error) }))
    return true
  }
  return false
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  let changed = false
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) {
      settings[key] = changes[key].newValue ?? DEFAULT_SETTINGS[key]
      changed = true
    }
  }
  if (changed) {
    disconnect()
    manualDisconnect = false
    connect()
  }
})

ensureKeepaliveAlarm()
loadSettings()
  .then(connect)
  .catch((error) => setState('error', String(error)))
