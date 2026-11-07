/**
 * dsh-browser-control — control a real Chrome/Edge browser from DeepSeek Harness.
 *
 * The plugin starts a loopback WebSocket server and registers browser_* tools.
 * A bundled Manifest V3 extension connects to that server and executes the
 * commands in the user's own browser profile (so logged-in sessions work).
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { BrowserBridge } from './bridge.js'
import { registerTools } from './tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-control'

/** Services required by the browser tool suite. */
export const inject = ['tools', 'systemPrompt']

/** Plugin configuration schema. */
export const Config = z.object({
  port: z.number().default(17373),
  token: z.string().default(''),
  commandTimeoutMs: z.number().default(30_000),
  screenshotDir: z.string().default(''),
  allowEval: z.boolean().default(true),
})

/**
 * Token file in the DSH home directory. Generated on first start so a fixed
 * default never ships in a public repository; set config.token or delete the
 * file to rotate. The value must match the token in the extension popup.
 */
export const TOKEN_FILE = join(homedir(), '.dsh', '.browser-control-token')

function resolveToken(configured) {
  if (typeof configured === 'string' && configured.length > 0) return configured
  try {
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (existing.length >= 16) return existing
  } catch {
    /* first run */
  }
  const generated = `dsh-${randomBytes(24).toString('base64url')}`
  try {
    mkdirSync(join(homedir(), '.dsh'), { recursive: true })
    writeFileSync(TOKEN_FILE, generated, 'utf8')
  } catch {
    /* read-only home: fall back to an in-memory token for this session */
  }
  return generated
}

/** Model-facing guidance contributed while the browser tools are registered. */
const GUIDANCE = [
  'You can control a real browser through the browser_* tools when the bundled extension is connected.',
  'Typical loop: browser_status -> browser_navigate -> browser_snapshot -> browser_click/browser_type -> browser_snapshot again.',
  'Snapshot refs ([e1], [e2], ...) are only valid for the page state they were read from; re-snapshot after every click, navigation, or DOM-changing action.',
  'Prefer browser_snapshot + refs over browser_eval. Use browser_extract to read page content, and browser_screenshot (then read_image) when layout matters.',
  'Snapshots pierce open Shadow DOM and list child iframes with their frameId; pass frameId to any tool to operate inside an iframe.',
  'For JS-rendered SPAs use browser_navigate with waitUntil "networkidle" (or browser_wait with a selector) before snapshotting.',
  'Use browser_hover for JS-driven menus/tooltips, browser_select for native and custom dropdowns, browser_drag for sliders/canvas/HTML5 drag targets.',
  'browser_click and browser_type use synthetic DOM events by default (isTrusted=false, fast). Pass real:true to use CDP trusted input when a site checks isTrusted; this briefly shows a "debugging" banner.',
  'Click results report the click mode and isTrusted. Errors carry codes like element_not_found, ref_stale, element_occluded; mutating tool failures also save a screenshot path as evidence.',
  'Use browser_scroll with toRef/toSelector to bring an element into view, or untilText to scroll virtual lists until the text appears.',
  'The WebSocket token is auto-generated into ~/.dsh/.browser-control-token on first start. If the extension reports 访问令牌不匹配, read that file and tell the user to paste its content into the extension popup settings.',
].join(' ')

export function apply(ctx, config) {
  const resolved = config ?? {}
  const port = resolved.port ?? 17373
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`browser-control: port 必须是 1-65535 的整数，收到 ${port}`)
  }
  const token = resolveToken(resolved.token)
  const commandTimeoutMs = resolved.commandTimeoutMs ?? 30_000
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1_000) {
    throw new Error('browser-control: commandTimeoutMs 必须是 >= 1000 的整数')
  }

  const log = (message) => {
    try {
      ctx.logger?.('browser-control')?.info?.(message)
    } catch {
      /* logging must never break the plugin */
    }
    if (ctx.logger === undefined) console.log(`[browser-control] ${message}`)
  }

  const bridge = new BrowserBridge({
    port,
    token,
    commandTimeoutMs,
    logger: log,
  })

  ctx.effect(() => {
    bridge.start()
    return () => bridge.dispose()
  }, 'browser-control.bridge')

  registerTools(ctx, {
    bridge,
    commandTimeoutMs,
    screenshotDir: resolved.screenshotDir ?? '',
    allowEval: resolved.allowEval !== false,
    tokenFile: TOKEN_FILE,
    token,
  })

  if (ctx.systemPrompt !== undefined) {
    ctx.systemPrompt.section({
      name: 'tool:browser_control',
      order: 3000,
      text: (context) => (ctx.tools.get('browser_status', context?.scope) === undefined ? '' : GUIDANCE),
    })
  }
}
