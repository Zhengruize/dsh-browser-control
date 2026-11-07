/**
 * Browser Bridge — the host half of the browser-control plugin.
 *
 * The plugin listens on 127.0.0.1:<port> for exactly one browser extension
 * WebSocket connection. Every model-facing tool call is translated into one
 * command frame, sent to the extension, and awaited as a response frame.
 *
 * Protocol (JSON text frames):
 *   extension -> host  { type: 'hello', token, version, browser, platform }
 *   host -> extension  { type: 'hello-ok', sessionId, server }
 *   host -> extension  { type: 'cmd', id, name, params }
 *   extension -> host  { type: 'res', id, ok, data?, error? }
 *   host -> extension  { type: 'ping', id }
 *   extension -> host  { type: 'pong', id }
 */
import { WebSocketServer } from 'ws'

const PING_INTERVAL_MS = 10_000
const HELLO_TIMEOUT_MS = 8_000
const PROTOCOL_VERSION = 1

/** Error type whose message is safe and useful to show the model. */
export class BrowserBridgeError extends Error {
  constructor(message, code = 'BRIDGE_ERROR') {
    super(message)
    this.name = 'BrowserBridgeError'
    this.code = code
  }
}

let nextMessageId = 1
function nextId() {
  return `m${nextMessageId++}`
}

export class BrowserBridge {
  constructor(options) {
    this.port = options.port
    this.token = options.token
    this.commandTimeoutMs = options.commandTimeoutMs
    this.logger = options.logger ?? (() => {})
    this.server = undefined
    this.session = undefined
    this.pingTimer = undefined
    this.lastError = undefined
    this.startedAt = undefined
    this.connectionCount = 0
  }

  get connected() {
    return this.session !== undefined
  }

  start() {
    if (this.server !== undefined) return
    this.startedAt = new Date()
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: this.port,
      maxPayload: 64 * 1024 * 1024,
      perMessageDeflate: false,
    })
    this.server = server
    server.on('listening', () => {
      this.logger(`listening on ws://127.0.0.1:${this.port}`)
    })
    server.on('error', (error) => {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.logger(`server error: ${this.lastError}`)
    })
    server.on('connection', (socket, request) => this.#onConnection(socket, request))
    this.pingTimer = setInterval(() => this.#ping(), PING_INTERVAL_MS)
    if (typeof this.pingTimer.unref === 'function') this.pingTimer.unref()
  }

  async dispose() {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer)
    this.pingTimer = undefined
    this.#dropSession('插件正在卸载，连接已关闭')
    if (this.server !== undefined) {
      const server = this.server
      this.server = undefined
      await new Promise((resolve) => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
  }

  /** Human readable status for browser_status. */
  status() {
    const session = this.session
    return {
      connected: session !== undefined,
      port: this.port,
      listenUrl: `ws://127.0.0.1:${this.port}`,
      startedAt: this.startedAt ? this.startedAt.toISOString() : undefined,
      connections: this.connectionCount,
      lastError: this.lastError,
      extension: session
        ? {
            version: session.info.version,
            browser: session.info.browser,
            platform: session.info.platform,
            connectedAt: session.connectedAt.toISOString(),
          }
        : undefined,
    }
  }

  /**
   * Send one command and await the extension's response.
   * @param {string} name extension command name
   * @param {object} params JSON-serializable parameters
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} options
   */
  async request(name, params = {}, options = {}) {
    const session = this.session
    if (session === undefined) {
      throw new BrowserBridgeError(
        '浏览器扩展未连接：请先在 Chrome/Edge 中加载 extension 目录并点击「连接」，' +
          `插件监听地址为 ws://127.0.0.1:${this.port}。`,
        'NOT_CONNECTED',
      )
    }
    if (options.signal?.aborted) {
      throw new BrowserBridgeError('操作已取消', 'ABORTED')
    }
    const id = nextId()
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs
    return await new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        session.pending.delete(id)
        clearTimeout(timer)
        if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
        fn(value)
      }
      const timer = setTimeout(() => {
        finish(reject, new BrowserBridgeError(`浏览器命令「${name}」超时（${timeoutMs}ms）`, 'TIMEOUT'))
      }, timeoutMs)
      const onAbort = () => finish(reject, new BrowserBridgeError('操作已取消', 'ABORTED'))
      if (options.signal !== undefined) options.signal.addEventListener('abort', onAbort, { once: true })
      session.pending.set(id, { resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) })
      try {
        session.socket.send(JSON.stringify({ type: 'cmd', id, name, params }))
      } catch (error) {
        finish(reject, new BrowserBridgeError(`发送命令失败：${error instanceof Error ? error.message : String(error)}`, 'SEND_FAILED'))
      }
    })
  }

  #ping() {
    const session = this.session
    if (session === undefined) return
    try {
      session.socket.send(JSON.stringify({ type: 'ping', id: nextId() }))
    } catch {
      /* the close handler will drop the session */
    }
  }

  #onConnection(socket, request) {
    const remote = request.socket.remoteAddress ?? 'unknown'
    this.connectionCount += 1
    let authenticated = false
    const helloTimer = setTimeout(() => {
      if (!authenticated) {
        try {
          socket.send(JSON.stringify({ type: 'hello-error', error: '握手超时' }))
        } catch {}
        socket.close(1008, 'hello timeout')
      }
    }, HELLO_TIMEOUT_MS)
    if (typeof helloTimer.unref === 'function') helloTimer.unref()

    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
      } catch {
        return
      }
      if (!authenticated) {
        if (message.type !== 'hello') {
          socket.close(1008, 'expected hello')
          return
        }
        authenticated = true
        clearTimeout(helloTimer)
        if (typeof message.token !== 'string' || message.token !== this.token) {
          try {
            socket.send(JSON.stringify({ type: 'hello-error', error: '访问令牌不匹配，请检查扩展中的 token 设置' }))
          } catch {}
          socket.close(1008, 'bad token')
          return
        }
        this.#replaceSession(socket, message)
        try {
          socket.send(
            JSON.stringify({
              type: 'hello-ok',
              sessionId: nextId(),
              server: { version: PROTOCOL_VERSION, plugin: 'dsh-browser-control' },
            }),
          )
        } catch {}
        this.logger(`extension connected from ${remote}`)
        return
      }

      if (message.type === 'res') {
        const pending = this.session?.pending.get(message.id)
        if (pending === undefined) return
        if (message.ok === true) pending.resolve(message.data)
        else {
          const detail = message.error && typeof message.error === 'object' ? message.error.message : message.error
          pending.reject(new BrowserBridgeError(String(detail ?? '浏览器命令执行失败'), 'EXTENSION_ERROR'))
        }
        return
      }
      if (message.type === 'pong') return
      if (message.type === 'log') {
        this.logger(`[extension] ${String(message.message ?? '')}`)
      }
    })

    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (this.session?.socket === socket) {
        this.#dropSession('浏览器扩展连接已断开')
      }
    })
    socket.on('error', () => {
      /* close handler reports the disconnect */
    })
  }

  #replaceSession(socket, hello) {
    if (this.session !== undefined && this.session.socket !== socket) {
      this.#dropSession('新的浏览器扩展连接已替换旧连接')
    }
    this.session = {
      socket,
      info: {
        version: typeof hello.version === 'string' ? hello.version : 'unknown',
        browser: hello.browser ?? 'unknown',
        platform: hello.platform ?? 'unknown',
      },
      connectedAt: new Date(),
      pending: new Map(),
    }
  }

  #dropSession(reason) {
    const session = this.session
    if (session === undefined) return
    this.session = undefined
    for (const pending of session.pending.values()) {
      pending.reject(new BrowserBridgeError(reason, 'DISCONNECTED'))
    }
    session.pending.clear()
    try {
      session.socket.close(1001, reason)
    } catch {}
  }
}
