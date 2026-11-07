import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserBridgeError } from './bridge.js'

const asText = (text) => [{ type: 'text', text: String(text) }]

/** Round-trip through JSON so tool results never contain undefined/Date/non-lossless values. */
function json(value) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}

/** defineTool wrapper that normalizes the canonical output to lossless JSON. */
function defineJsonTool(options) {
  const execute = options.execute
  const render = options.output?.render
  const output =
    render === undefined
      ? options.output
      : {
          ...options.output,
          render: (args, value) => {
            try {
              const rendered = render(args, value)
              return rendered ?? asText('（无输出）')
            } catch (error) {
              return asText(
                `结果渲染失败，原始结果：\n${pretty(value)}\n（渲染错误：${error instanceof Error ? error.message : String(error)}）`,
              )
            }
          },
        }
  return defineTool({
    ...options,
    output,
    async execute(args, exec) {
      return json(await execute(args, exec))
    },
  })
}

function pretty(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function pageLine(page) {
  if (page === undefined || page === null) return ''
  const title = page.title ? page.title : '(无标题)'
  return `页面：${title}\nURL：${page.url ?? ''}`
}

function elementLine(element) {
  if (element === undefined || element === null) return ''
  const parts = []
  if (element.ref) parts.push(`[${element.ref}]`)
  if (element.tag) parts.push(`<${element.tag}>`)
  if (element.text) parts.push(`"${element.text}"`)
  return parts.join(' ')
}

function formatSnapshot(value) {
  const payload = value ?? {}
  const lines = []
  const page = payload.page ?? {}
  lines.push(`页面：${page.title || '(无标题)'}`)
  lines.push(`URL：${page.url ?? ''}`)
  if (page.viewport) lines.push(`视口：${page.viewport.width}x${page.viewport.height}，滚动 ${page.scroll?.y ?? 0}/${page.scroll?.height ?? 0}`)
  const elements = Array.isArray(payload.elements) ? payload.elements : []
  lines.push('')
  lines.push(`可交互元素（${elements.length}${payload.total ? ` / 共 ${payload.total}` : ''}）：`)
  if (elements.length === 0) {
    lines.push('（当前视口内没有识别到可交互元素，可尝试 browser_extract 或 browser_scroll）')
  }
  for (const element of elements) {
    const meta = []
    if (element.role) meta.push(`role=${element.role}`)
    if (element.type) meta.push(`type=${element.type}`)
    if (element.name) meta.push(`name=${element.name}`)
    if (element.placeholder) meta.push(`placeholder=${element.placeholder}`)
    if (element.href) meta.push(`href=${element.href}`)
    if (element.value !== undefined && element.value !== '') meta.push(`value=${JSON.stringify(element.value).slice(0, 120)}`)
    if (element.disabled) meta.push('disabled')
    if (element.checked) meta.push('checked')
    if (element.inShadow) meta.push(element.shadowPath ? `shadow=${element.shadowPath}` : 'shadow')
    lines.push(`[${element.ref}] <${element.tag}> "${element.text ?? ''}"${meta.length ? '  ' + meta.join(' ') : ''}`)
  }
  if (payload.truncated) {
    lines.push('')
    lines.push(`（已截断：页面共 ${payload.total} 个可交互元素，只返回前 ${elements.length} 个；可调大 maxElements 或用 frameId 分框架快照）`)
  }
  if (payload.generation !== undefined) {
    lines.push(`引用代数：${payload.generation}（重新快照会递增；过期 ref 会返回 ref_stale）`)
  }
  const headings = Array.isArray(payload.headings) ? payload.headings : []
  if (headings.length > 0) {
    lines.push('')
    lines.push('标题结构：')
    for (const heading of headings) lines.push(`${'  '.repeat(Math.max(0, heading.level - 1))}h${heading.level} ${heading.text}`)
  }
  const frames = Array.isArray(payload.frames) ? payload.frames : []
  if (frames.length > 0) {
    lines.push('')
    lines.push(`子框架（${frames.length}，可用 frameId 参数单独操作）：`)
    for (const frame of frames.slice(0, 10)) lines.push(`  frameId=${frame.frameId} ${String(frame.url ?? '').slice(0, 160)}`)
  }
  if (payload.shadowHosts) {
    lines.push('')
    lines.push(`检测到 ${payload.shadowHosts} 个 open Shadow DOM 宿主，快照已包含其内部元素。`)
  }
  if (payload.textPreview) {
    lines.push('')
    lines.push('正文预览：')
    lines.push(String(payload.textPreview))
  }
  return lines.join('\n')
}

function formatTabs(value) {
  const payload = value ?? {}
  const lines = []
  if (payload.action === 'list' || payload.tabs !== undefined) {
    const tabs = Array.isArray(payload.tabs) ? payload.tabs : []
    lines.push(`浏览器标签页（${tabs.length}）：`)
    for (const tab of tabs) {
      const active = tab.active ? ' *当前*' : ''
      lines.push(`  [${tab.id}] ${tab.title || '(无标题)'} — ${tab.url}${active}`)
    }
  }
  if (payload.action === 'open' || payload.action === 'activate') {
    lines.push(`已${payload.action === 'open' ? '打开' : '切换到'}标签页 [${payload.tab?.id ?? '?'}] ${payload.tab?.title ?? ''} — ${payload.tab?.url ?? ''}`)
  }
  if (payload.action === 'close') {
    lines.push(`已关闭标签页 [${payload.closedTabId ?? '?'}]`)
  }
  if (lines.length === 0) lines.push('（没有标签页信息）')
  return lines.join('\n')
}

function formatExtract(value) {
  const payload = value ?? {}
  const lines = []
  const page = payload.page ?? {}
  lines.push(`页面：${page.title || '(无标题)'} — ${page.url ?? ''}`)
  if (payload.format) lines.push(`格式：${payload.format}${payload.truncated ? '（已截断）' : ''}`)
  lines.push('')
  lines.push(String(payload.content ?? ''))
  return lines.join('\n')
}

function formatScreenshot(value) {
  const payload = value ?? {}
  return [
    `截图已保存：${payload.path}`,
    `尺寸：${payload.width ?? '?'}x${payload.height ?? '?'}，约 ${Math.round((payload.bytes ?? 0) / 1024)} KB`,
    `页面：${payload.page?.title ?? ''} — ${payload.page?.url ?? ''}`,
    '',
    '提示：可使用 read_image 工具查看该文件。',
  ].join('\n')
}

/** Save a PNG data URL to disk and report path/dimensions. */
async function saveScreenshot(dataUrl, directory) {
  const match = /^data:image\/png;base64,(.+)$/s.exec(String(dataUrl ?? ''))
  if (match === null) throw new BrowserBridgeError('扩展返回的截图数据无效', 'BAD_SCREENSHOT')
  const buffer = Buffer.from(match[1], 'base64')
  const width = buffer.length > 24 ? buffer.readUInt32BE(16) : undefined
  const height = buffer.length > 24 ? buffer.readUInt32BE(20) : undefined
  const dir = directory && directory.length > 0 ? directory : join(tmpdir(), 'dsh-browser-screenshots')
  await mkdir(dir, { recursive: true })
  const filename = `browser-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${Math.random().toString(16).slice(2, 8)}.png`
  const path = join(dir, filename)
  await writeFile(path, buffer)
  return { path, bytes: buffer.length, width, height }
}

/** Register every model-facing browser tool on the plugin context. */
export function registerTools(ctx, options) {
  const { bridge } = options
  const timeoutMs = Math.max(15_000, options.commandTimeoutMs ?? 30_000)
  const toolTimeout = timeoutMs + 10_000
  const screenshotDir = options.screenshotDir
  const activeToken = options.token

  const commonTab = {
    tabId: {
      type: 'number',
      description: '目标标签页 ID；省略时使用当前活动标签页。Id of the target tab; omit for the active tab.',
    },
    frameId: {
      type: 'number',
      description:
        '可选：目标 iframe 的 frameId（0 表示主框架）。省略时会先在主框架查找，找不到元素再自动尝试子框架。Frame id; omit to search the top frame and fall back to iframes.',
    },
  }

  const command = (name, params, exec) =>
    bridge.request(name, params, { signal: exec?.signal, timeoutMs })

  /**
   * On failure, attach a screenshot of the current viewport so the model can see
   * what actually happened instead of reasoning from an error string alone.
   */
  const withEvidence = async (exec, args, error) => {
    const message = error instanceof Error ? error.message : String(error)
    try {
      const shot = await command('screenshot', { tabId: args.tabId }, exec)
      if (shot?.dataUrl) {
        const saved = await saveScreenshot(shot.dataUrl, screenshotDir)
        const where = shot.page ? `\n页面：${shot.page.title ?? ''} — ${shot.page.url ?? ''}` : ''
        return `${message}${where}\n失败现场截图：${saved.path}（可用 read_image 查看）`
      }
    } catch {
      /* screenshot is best effort */
    }
    return message
  }

  /** Run an element-mutating command, adding evidence when it fails. */
  const mutate = async (exec, args, name, params) => {
    try {
      const value = await command(name, params, exec)
      // A null result means the page side produced no payload (for example the
      // element disappeared between snapshot and click). Surface that instead of
      // rendering a misleading success message.
      if (value === undefined || value === null) {
        throw new Error(
          `浏览器没有返回 ${name} 的结果：元素可能已从页面移除或页面已刷新。请重新 browser_snapshot 后再操作。`,
        )
      }
      return value
    } catch (error) {
      throw new Error(await withEvidence(exec, args, error))
    }
  }

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_status',
      description:
        '查看浏览器控制连接状态、扩展版本与当前活动标签页。Check whether the bundled Chrome/Edge extension is connected, and which tab is active. 无需连接也可调用，用来排查扩展未连接的问题。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (args, value) => asText(formatStatus(value)),
      },
      timeoutMs: toolTimeout,
      async execute() {
        const status = bridge.status()
        const extra = activeToken === undefined ? {} : { tokenHint: '扩展弹窗里的 token 需要与插件配置或 ~/.dsh/.browser-control-token 一致' }
        if (!status.connected) return { ...status, activeTab: undefined, ...extra }
        try {
          const info = await command('status', {})
          return { ...status, ...info }
        } catch (error) {
          return {
            ...status,
            connected: false,
            detailError: error instanceof Error ? error.message : String(error),
            ...extra,
          }
        }
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_tabs',
      description:
        '列出、打开、切换或关闭浏览器标签页。List/open/activate/close browser tabs. action=list 返回所有标签页；action=open 需要 url；action=activate/close 需要 tabId。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'open', 'activate', 'close'],
          description: '操作类型。One of list, open, activate, close.',
        },
        url: { type: 'string', description: 'action=open 时要打开的 URL。URL for action=open.' },
        tabId: { type: 'number', description: 'action=activate/close 时的目标标签页 ID。Target tab id.' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => asText(formatTabs(value)),
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (args.action === 'list') {
          const data = await command('tabs.list', {}, exec)
          return { action: 'list', ...data }
        }
        if (args.action === 'open') {
          if (!args.url) throw new Error('action=open 需要提供 url 参数')
          return { action: 'open', ...(await command('tabs.open', { url: args.url }, exec)) }
        }
        if (args.action === 'activate') {
          if (args.tabId === undefined) throw new Error('action=activate 需要提供 tabId 参数')
          return { action: 'activate', ...(await command('tabs.activate', { tabId: args.tabId }, exec)) }
        }
        if (args.action === 'close') {
          if (args.tabId === undefined) throw new Error('action=close 需要提供 tabId 参数')
          return { action: 'close', ...(await command('tabs.close', { tabId: args.tabId }, exec)) }
        }
        throw new Error(`未知的 action: ${String(args.action)}`)
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_navigate',
      description:
        '让浏览器标签页打开一个 URL 并等待页面加载。Navigate a tab to a URL and wait for load. waitUntil 可选 load / domcontentloaded / networkidle（SPA 推荐：等 AJAX 渲染稳定）/ none；还可传 waitFor 选择器等它出现。返回最终 URL 与标题；之后建议 browser_snapshot。',
      parameters: {
        url: { type: 'string', required: true, description: '要打开的完整 URL（含 https://）。The URL to open.' },
        ...commonTab,
        waitUntil: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle', 'none'],
          description: '等待的加载状态，默认 load。networkidle 会额外等到资源请求 600ms 无变化（适合纯 JS 渲染的 SPA）。Load state to wait for (default load).',
        },
        waitFor: {
          type: 'string',
          description: '可选：加载后再等待该 CSS 选择器出现（最多等到 timeoutMs）。Optional selector to wait for after load.',
        },
        timeoutMs: { type: 'number', description: '加载超时毫秒数，默认 20000。Navigation timeout in ms.' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => {
          const payload = value ?? {}
          const waited = payload.waited
          return asText(
            `已导航到：${payload.page?.url ?? args.url}\n标题：${payload.page?.title ?? '(无标题)'}${
              waited ? `\n等待 ${args.waitFor}：${waited.matched ? '已出现' : '超时未出现'}` : ''
            }`,
          )
        },
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return await command(
          'navigate',
          {
            url: args.url,
            tabId: args.tabId,
            frameId: args.frameId,
            waitUntil: args.waitUntil ?? 'load',
            waitFor: args.waitFor,
            timeoutMs: args.timeoutMs ?? 20_000,
          },
          exec,
        )
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_snapshot',
      description:
        '读取当前页面的结构快照：URL、标题、可交互元素（带 [eN] 引用）、标题结构与正文预览。Read a structural snapshot of the page with stable [eN] refs for clicking/typing. 已穿透 open Shadow DOM；若页面含 iframe，结果会列出子框架及 frameId，可传 frameId 单独快照子框架。点击/输入后请重新调用本工具，因为引用会刷新。',
      parameters: {
        ...commonTab,
        maxElements: { type: 'number', description: '最多返回的可交互元素数量，默认 120。Max interactive elements.' },
        includeText: { type: 'boolean', description: '是否包含正文预览，默认 true。Include a text preview.' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => asText(formatSnapshot(value)),
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await command(
          'snapshot',
          {
            tabId: args.tabId,
            frameId: args.frameId,
            maxElements: args.maxElements ?? 120,
            includeText: args.includeText ?? true,
          },
          exec,
        )
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_click',
      description:
        '点击页面元素。Click an element by snapshot ref, CSS selector, or visible text. 推荐先用 browser_snapshot 获取 ref，再点击 [eN]；也可用 selector 或 text 定位。默认走 DOM 合成事件（快、isTrusted=false）；传 real:true 改用 chrome.debugger 的 CDP Input.dispatchMouseEvent，产生可信点击（浏览器会显示"正在调试"提示条，适合检查 isTrusted 的站点）。点击前做遮挡检测，被弹窗/遮罩挡住会报 element_occluded。',
      parameters: {
        ...commonTab,
        ref: { type: 'string', description: '快照中的元素引用，例如 e12。Snapshot ref.' },
        selector: { type: 'string', description: 'CSS 选择器。CSS selector.' },
        text: { type: 'string', description: '元素可见文本（精确或包含匹配）。Visible text to match.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标按键，默认 left。Mouse button.' },
        clickCount: { type: 'number', description: '点击次数，默认 1。Click count.' },
        real: { type: 'boolean', description: '用 CDP 派发可信点击（isTrusted=true），需要 debugger 权限，默认 false。Use CDP for a trusted click.' },
        force: { type: 'boolean', description: '即使检测到遮挡也继续点击，默认 false。Ignore occlusion check.' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => {
          const payload = value ?? {}
          const lines = [
            `已点击 ${elementLine(payload.element) || (args.ref ?? args.selector ?? args.text ?? '元素')}`,
            `当前页面：${payload.page?.title ?? ''} — ${payload.page?.url ?? ''}`,
            `点击方式：${payload.mode === 'real' ? 'CDP 可信点击' : '合成事件'}${
              payload.trusted === undefined ? '' : `（isTrusted=${payload.trusted}）`
            }`,
          ]
          if (payload.warning) lines.push(`注意：${payload.warning}`)
          return asText(lines.join('\n'))
        },
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        requireLocator(args)
        return await mutate(exec, args, 'click', {
          tabId: args.tabId,
          frameId: args.frameId,
          ref: args.ref,
          selector: args.selector,
          text: args.text,
          button: args.button ?? 'left',
          clickCount: args.clickCount ?? 1,
          real: args.real ?? false,
          force: args.force ?? false,
        })
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_hover',
      description:
        '把鼠标移到元素上并触发 hover（mouseover/mouseenter/mousemove），用于展开二级菜单、显示悬浮提示。Hover an element to open menus/tooltips. 注意：合成事件能触发 JS 监听，但无法产生 CSS :hover 状态，纯 CSS 悬浮菜单请改用 browser_eval 或点击。',
      parameters: {
        ...commonTab,
        ref: { type: 'string', description: '快照中的元素引用。Snapshot ref.' },
        selector: { type: 'string', description: 'CSS 选择器。CSS selector.' },
        text: { type: 'string', description: '元素可见文本。Visible text.' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) =>
          asText(`已悬停 ${elementLine(value?.element) || args.ref || args.selector || args.text}\n页面：${value?.page?.title ?? ''}`),
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        requireLocator(args)
        return await mutate(exec, args, 'hover', {
          tabId: args.tabId,
          frameId: args.frameId,
          ref: args.ref,
          selector: args.selector,
          text: args.text,
        })
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_select',
      description:
        '选择下拉框选项：原生 <select> 直接按 value/label 选中；Ant Design / Element UI 等自定义下拉框会点击展开、等待菜单挂载（含 portal 与虚拟滚动）、再按文本点选项。Choose a dropdown option, native or custom. 用 ref/selector 定位下拉框本身；超时与尝试次数会在结果里给出。',
      parameters: {
        ...commonTab,
        ref: { type: 'string', description: '下拉框元素引用。Dropdown ref.' },
        selector: { type: 'string', description: '下拉框 CSS 选择器。Dropdown CSS selector.' },
        value: { type: 'string', description: '原生 select 的 option value。Option value for native select.' },
        label: { type: 'string', description: '选项可见文本（原生或自定义下拉框都可用）。Visible option text.' },
        text: { type: 'string', description: '同上，label 的别名（方便直接用可见文本定位选项）。Alias of label.' },
        optionTimeoutMs: { type: 'number', description: '自定义下拉框等待选项出现的最长毫秒数，默认 2500。Max wait for options.' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => {
          const payload = value ?? {}
          const lines = [
            `已选择：${payload.selected?.label ?? payload.selected?.value ?? args?.label ?? args?.text ?? args?.value ?? ''}${
              payload.native === false ? '（自定义下拉框）' : ''
            }`,
          ]
          if (payload.attempts) lines.push(`选项加载尝试：${payload.attempts} 次`)
          return asText(lines.join('\n'))
        },
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (!args.ref && !args.selector) throw new Error('browser_select 需要 ref 或 selector 定位下拉框')
        const label = args.label ?? args.text
        if (args.value === undefined && label === undefined) throw new Error('browser_select 需要 value、label 或 text 之一')
        return await mutate(exec, args, 'select', {
          tabId: args.tabId,
          frameId: args.frameId,
          ref: args.ref,
          selector: args.selector,
          value: args.value,
          label,
          optionTimeoutMs: args.optionTimeoutMs ?? 2500,
        })
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_type',
      description:
        '向输入框、文本域或可编辑元素输入文本。Type text into an input/textarea/contenteditable. 先用 browser_snapshot 获取 ref。默认走 DOM 事件（beforeinput/input/change，已兼容 React 受控组件）；传 real:true 改用 CDP Input.insertText 产生可信输入。可选择清空原值（默认清空）或输入后按回车提交。',
      parameters: {
        ...commonTab,
        ref: { type: 'string', description: '快照中的元素引用。Snapshot ref.' },
        selector: { type: 'string', description: 'CSS 选择器。CSS selector.' },
        text: { type: 'string', required: true, description: '要输入的文本。Text to type.' },
        clear: { type: 'boolean', description: '是否先清空已有内容，默认 true。Clear before typing.' },
        pressEnter: { type: 'boolean', description: '输入后是否按 Enter，默认 false。Press Enter after typing.' },
        real: { type: 'boolean', description: '用 CDP 产生可信输入（isTrusted=true），需要 debugger 权限，默认 false。Use CDP for trusted typing.' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => {
          const payload = value ?? {}
          const shown = payload.value ?? args?.text ?? ''
          return asText(
            `已输入到 ${elementLine(payload.element) || args?.ref || args?.selector || '元素'}：${String(shown).slice(0, 200)}\n当前页面：${payload.page?.title ?? ''} — ${payload.page?.url ?? ''}\n输入方式：${payload.mode === 'real' ? 'CDP 可信输入' : '合成事件'}`,
          )
        },
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (!args.ref && !args.selector) throw new Error('browser_type 需要 ref 或 selector 参数')
        return await mutate(exec, args, 'type', {
          tabId: args.tabId,
          frameId: args.frameId,
          ref: args.ref,
          selector: args.selector,
          text: args.text,
          clear: args.clear ?? true,
          pressEnter: args.pressEnter ?? false,
          real: args.real ?? false,
        })
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_press_key',
      description:
        '在当前焦点元素或指定元素上按下键盘按键。Press a keyboard key (e.g. Enter, Escape, ArrowDown, Tab, or a single character). 可带修饰键。',
      parameters: {
        ...commonTab,
        key: { type: 'string', required: true, description: '按键名，例如 Enter、Escape、Tab、ArrowDown、a。Key name.' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: '修饰键数组，例如 ["Control","Shift"]。Modifier keys.',
        },
        ref: { type: 'string', description: '可选：目标元素引用。Optional target ref.' },
        selector: { type: 'string', description: '可选：目标元素 CSS 选择器。Optional target selector.' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => {
          const payload = value ?? {}
          return asText(`已按下按键：${payload.key ?? args.key}${payload.element ? `（${elementLine(payload.element)}）` : ''}`)
        },
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return await command(
          'pressKey',
          {
            tabId: args.tabId,
            frameId: args.frameId,
            key: args.key,
            modifiers: args.modifiers ?? [],
            ref: args.ref,
            selector: args.selector,
          },
          exec,
        )
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_scroll',
      description:
        '滚动页面或指定元素。Scroll the page or a container. 支持上下（up/down/top/bottom）与左右（left/right），可按像素滚动或指定容器；传 toRef/toSelector 把某元素滚进视口；传 untilText 边滚边找文本（适合虚拟列表、无限滚动），找到即停。之后重新 browser_snapshot。',
      parameters: {
        ...commonTab,
        direction: {
          type: 'string',
          enum: ['up', 'down', 'top', 'bottom', 'left', 'right'],
          description: '滚动方向，默认 down（untilText 时表示查找方向）。Scroll direction.',
        },
        pixels: { type: 'number', description: '滚动像素数，默认 600。Pixels to scroll.' },
        ref: { type: 'string', description: '可选：滚动该元素内部而不是整页。Optional element ref to scroll inside.' },
        selector: { type: 'string', description: '可选：滚动该元素内部。Optional selector to scroll inside.' },
        toRef: { type: 'string', description: '把该元素滚动到视口内。Scroll this element into view.' },
        toSelector: { type: 'string', description: '把 CSS 选择器命中的元素滚动到视口内。Scroll this selector into view.' },
        untilText: { type: 'string', description: '边滚边查找的文本。Text to look for while scrolling (virtual lists).' },
        containerRef: { type: 'string', description: 'untilText 的滚动容器引用；省略则滚整页。Container ref for untilText.' },
        containerSelector: { type: 'string', description: 'untilText 的滚动容器选择器。Container selector for untilText.' },
        maxSteps: { type: 'number', description: 'untilText 最大滚动次数，默认 20。Max scroll steps.' },
        align: { type: 'string', enum: ['center', 'start'], description: 'toRef 的对齐方式，默认 center。Scrolling alignment.' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => {
          const payload = value ?? {}
          if (payload.matched !== undefined) {
            return asText(
              `文本查找：${payload.matched ? `已找到「${payload.text}」` : `未找到「${payload.text}」`}（滚动 ${payload.steps ?? 0} 次）\n页面：${payload.page?.title ?? ''} — ${payload.page?.url ?? ''}`,
            )
          }
          if (payload.inViewport !== undefined) {
            return asText(
              `已滚动到 ${elementLine(payload.element) || args.toRef || args.toSelector}${payload.inViewport ? '（已在视口内）' : '（仍在视口外）'}`,
            )
          }
          const scroll = payload.scroll ?? {}
          return asText(
            `已滚动 ${scroll.direction ?? args.direction ?? 'down'}；当前滚动位置 ${Math.round(scroll.top ?? scroll.left ?? 0)} / ${Math.round(scroll.height ?? 0)}`,
          )
        },
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return await command(
          'scroll',
          {
            tabId: args.tabId,
            frameId: args.frameId,
            direction: args.direction ?? 'down',
            pixels: args.pixels ?? 600,
            ref: args.ref,
            selector: args.selector,
            toRef: args.toRef,
            toSelector: args.toSelector,
            untilText: args.untilText,
            containerRef: args.containerRef,
            containerSelector: args.containerSelector,
            maxSteps: args.maxSteps ?? 20,
            align: args.align ?? 'center',
          },
          exec,
        )
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_drag',
      description:
        '模拟鼠标按住并拖动：在起点按下、按指定步数移动到终点、再松开。Simulate a mouse press-and-drag from a start point to an end point. 起点/终点可给坐标（fromX/fromY、toX/toY）或元素引用（fromRef/fromSelector、toRef/toSelector，取元素中心）。适合滑块、画布、可拖拽卡片。若目标使用原生 HTML5 拖放（draggable 属性 + dragstart/drop），传 html5:true 改为派发 DragEvent 序列。',
      parameters: {
        ...commonTab,
        fromRef: { type: 'string', description: '起点元素引用（取元素中心）。Optional start element ref.' },
        fromSelector: { type: 'string', description: '起点元素 CSS 选择器。Optional start element selector.' },
        fromX: { type: 'number', description: '起点视口 X 坐标（与 fromY 一起用）。Start X in viewport pixels.' },
        fromY: { type: 'number', description: '起点视口 Y 坐标。Start Y in viewport pixels.' },
        toRef: { type: 'string', description: '终点元素引用（取元素中心）。Optional end element ref.' },
        toSelector: { type: 'string', description: '终点元素 CSS 选择器。Optional end element selector.' },
        toX: { type: 'number', description: '终点视口 X 坐标（与 toY 一起用）。End X in viewport pixels.' },
        toY: { type: 'number', description: '终点视口 Y 坐标。End Y in viewport pixels.' },
        steps: { type: 'number', description: '移动分几步完成，默认 12。Number of intermediate move steps.' },
        durationMs: { type: 'number', description: '整个拖动时长毫秒，默认 400。Total drag duration in ms.' },
        holdMs: { type: 'number', description: '松开前按住停顿毫秒，默认 60。Hold before release in ms.' },
        html5: { type: 'boolean', description: '使用原生 HTML5 拖放事件（dragstart/dragover/drop）而不是指针事件，默认 false。Use native HTML5 DnD events.' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: '鼠标按键，默认 left。Mouse button.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => {
          const drag = (value ?? {}).drag ?? {}
          const from = drag.from ?? {}
          const to = drag.to ?? {}
          return asText(
            `已拖动：(${Math.round(from.x ?? args.fromX ?? 0)}, ${Math.round(from.y ?? args.fromY ?? 0)}) → (${Math.round(to.x ?? args.toX ?? 0)}, ${Math.round(to.y ?? args.toY ?? 0)})，${drag.steps ?? args.steps ?? 12} 步${drag.mode === 'html5' ? '（HTML5 拖放）' : ''}`,
          )
        },
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return await mutate(exec, args, 'drag', {
          tabId: args.tabId,
          frameId: args.frameId,
          fromRef: args.fromRef,
          fromSelector: args.fromSelector,
          fromX: args.fromX,
          fromY: args.fromY,
          toRef: args.toRef,
          toSelector: args.toSelector,
          toX: args.toX,
          toY: args.toY,
          steps: args.steps ?? 12,
          durationMs: args.durationMs ?? 400,
          holdMs: args.holdMs ?? 60,
          button: args.button ?? 'left',
          html5: args.html5 ?? false,
        })
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_extract',
      description:
        '提取页面内容为纯文本、Markdown、HTML 或链接列表。Extract page content as text, markdown, html, or links. 可传 selector 限定区域；适合阅读文章、表格或核对页面信息。',
      parameters: {
        ...commonTab,
        selector: { type: 'string', description: '可选：只提取该 CSS 选择器匹配的区域。Optional CSS selector.' },
        format: {
          type: 'string',
          enum: ['text', 'markdown', 'html', 'links'],
          description: '输出格式，默认 text。Output format (default text).',
        },
        maxChars: { type: 'number', description: '最大字符数，默认 20000。Max characters.' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => asText(formatExtract(value)),
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await command(
          'extract',
          {
            tabId: args.tabId,
            frameId: args.frameId,
            selector: args.selector,
            format: args.format ?? 'text',
            maxChars: args.maxChars ?? 20_000,
          },
          exec,
        )
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_screenshot',
      description:
        '截取当前活动标签页的可视区域并保存为 PNG 文件。Capture the visible viewport as a PNG. 返回文件路径，可用 read_image 查看；仅截取可见区域，不含整页长截图。',
      parameters: {
        ...commonTab,
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => asText(formatScreenshot(value)),
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const shot = await command('screenshot', { tabId: args.tabId }, exec)
        const saved = await saveScreenshot(shot.dataUrl, screenshotDir)
        return { ...saved, page: shot.page }
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_eval',
      description:
        '在页面中执行一段 JavaScript 表达式并返回结果（高级用法）。Evaluate a JavaScript expression in the page and return the JSON-safe result. 仅在有明确需要时使用，例如读取页面全局变量或调用前端 API。',
      parameters: {
        ...commonTab,
        expression: { type: 'string', required: true, description: '要执行的 JavaScript 表达式或代码。JavaScript expression to evaluate.' },
        awaitPromise: { type: 'boolean', description: '表达式返回 Promise 时是否等待，默认 true。Await a returned promise (default true).' },
        world: {
          type: 'string',
          enum: ['main', 'isolated'],
          description:
            '执行环境：main（默认，页面主世界，可访问页面变量，也受页面 CSP 约束）或 isolated（扩展隔离环境，部分浏览器禁止其使用 eval）。Execution world.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => {
          const payload = value ?? {}
          const result = payload.result
          let rendered
          try {
            rendered = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          } catch {
            rendered = String(result)
          }
          const text = rendered === undefined ? 'undefined' : String(rendered)
          const truncated = text.length > 8000 ? text.slice(0, 8000) + '\n…（已截断）' : text
          return asText(`browser_eval 结果（${payload.resultType ?? typeof result}）：\n${truncated}`)
        },
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (options.allowEval === false) throw new Error('browser_eval 已被插件配置禁用（allowEval: false）')
        return await command(
          'eval',
          {
            tabId: args.tabId,
            frameId: args.frameId,
            expression: args.expression,
            awaitPromise: args.awaitPromise ?? true,
            world: args.world ?? 'main',
          },
          exec,
        )
      },
    }),
  )

  ctx.tools.register(
    defineJsonTool({
      name: 'browser_wait',
      description:
        '等待页面出现/隐藏某个元素或文本。Wait until a selector or visible text appears (or disappears). 用于等待异步加载完成，例如搜索结果、弹窗或按钮。',
      parameters: {
        ...commonTab,
        selector: { type: 'string', description: '等待的 CSS 选择器。CSS selector to wait for.' },
        text: { type: 'string', description: '等待出现的可见文本。Visible text to wait for.' },
        state: {
          type: 'string',
          enum: ['visible', 'hidden', 'attached', 'detached'],
          description:
            '等待状态，默认 visible。visible/hidden 判断可见性，attached/detached 只判断元素是否存在。Desired state (default visible).',
        },
        timeoutMs: { type: 'number', description: '超时毫秒数，默认 15000。Timeout in ms.' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => {
          const payload = value ?? {}
          return asText(
            `等待完成：${payload.matched ? '已满足条件' : '条件未满足（超时）'}，耗时 ${payload.elapsedMs ?? '?'}ms${
              payload.detail ? `（匹配 ${payload.detail.count ?? 0} 个）` : ''
            }\n页面：${payload.page?.title ?? ''} — ${payload.page?.url ?? ''}`,
          )
        },
      },
      timeoutMs: toolTimeout,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (!args.selector && !args.text) throw new Error('browser_wait 需要 selector 或 text 参数')
        return await command(
          'wait',
          {
            tabId: args.tabId,
            frameId: args.frameId,
            selector: args.selector,
            text: args.text,
            state: args.state ?? 'visible',
            timeoutMs: args.timeoutMs ?? 15_000,
          },
          exec,
        )
      },
    }),
  )
}

function requireLocator(args) {
  if (!args.ref && !args.selector && !args.text) {
    throw new Error('需要 ref、selector 或 text 之一来定位元素')
  }
}

function formatStatus(value) {
  const payload = value ?? {}
  const lines = []
  lines.push(`连接状态：${payload.connected ? '已连接' : '未连接'}`)
  lines.push(`监听地址：${payload.listenUrl ?? 'ws://127.0.0.1:' + (payload.port ?? '?')}`)
  if (payload.extension) {
    lines.push(`扩展版本：${payload.extension.version ?? '?'}`)
    lines.push(`浏览器：${payload.extension.browser ?? '?'}（${payload.extension.platform ?? '?'}）`)
    lines.push(`连接时间：${payload.extension.connectedAt ?? '?'}`)
  }
  if (payload.activeTab) {
    lines.push('')
    lines.push(`活动标签页：${payload.activeTab.title || '(无标题)'}`)
    lines.push(`URL：${payload.activeTab.url ?? ''}`)
  }
  if (!payload.connected) {
    lines.push('')
    lines.push('如何连接：')
    lines.push('1. 在 Chrome/Edge 打开扩展管理页，开启「开发者模式」，选择「加载已解压的扩展程序」，指向本插件的 extension 目录。')
    lines.push(`2. 点击扩展图标，服务器地址填 ws://127.0.0.1:${payload.port ?? 17373}，令牌粘贴 ~/.dsh/.browser-control-token（或插件配置里的 token），点击「连接」。`)
    lines.push('3. 再次调用 browser_status 确认已连接。')
    if (payload.lastError) lines.push(`最近错误：${payload.lastError}`)
    if (payload.detailError) lines.push(`详情：${payload.detailError}`)
  }
  return lines.join('\n')
}
