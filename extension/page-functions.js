/**
 * Injected page functions for the DSH Browser Control extension.
 *
 * `pageExec` is serialized by chrome.scripting.executeScript and runs inside
 * the target page. It must be fully self-contained: it may not reference any
 * module-scope value. Keep every helper inside the function body.
 *
 * Design notes:
 * - Refs ([eN]) are kept in memory (globalThis.__dshState.refs), never as DOM
 *   attributes, so pages cannot detect automation through data-* pollution.
 * - Every DOM query walks open shadow roots (Web Components), and hit testing
 *   pierces shadow boundaries too.
 * - Iframes are handled by background.js, which re-runs the same op in child
 *   frames when the top frame cannot resolve the element.
 */

export async function pageExec(op, params) {
  const LEGACY_REF = 'data-dsh-ref'
  const MAX_TEXT = 160
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const sleep = (ms) => new Promise((resolveTimer) => setTimeout(resolveTimer, ms))

  /** Per-document isolated-world state: ref table for [eN] handles. */
  const state = (() => {
    const key = '__dshState'
    const existing = globalThis[key]
    if (!existing || !(existing.refs instanceof Map)) {
      globalThis[key] = { refs: new Map(), refOf: new Map(), gen: 0, lastInput: null, probe: false }
    }
    if (!(globalThis[key].refOf instanceof Map)) globalThis[key].refOf = new Map()
    return globalThis[key]
  })()

  /** Error carrying a machine-readable code that the host surfaces verbatim. */
  const fail = (code, message) => {
    const error = new Error(`[${code}] ${message}`)
    error.code = code
    return error
  }

  /**
   * Record the last pointer event the page actually received. A trusted event
   * can only come from the browser itself (CDP / real user), which lets the
   * host report whether a click was synthetic or real.
   */
  const installProbe = () => {
    if (state.probe) return
    state.probe = true
    state.lastInput = null
    const record = (event) => {
      try {
        state.lastInput = {
          type: event.type,
          isTrusted: event.isTrusted === true,
          time: Date.now(),
          target: describe(event.target),
        }
      } catch {}
    }
    for (const type of ['pointerdown', 'mousedown', 'click', 'keydown']) {
      window.addEventListener(type, record, true)
    }
  }

  const rootOf = (el) => {
    try {
      const root = el.getRootNode ? el.getRootNode() : null
      return root && root.host ? root : null
    } catch {
      return null
    }
  }

  const inShadow = (el) => rootOf(el) !== null

  /** Human-readable path across shadow boundaries, e.g. my-card#host > #shadow-root > button. */
  const shadowPath = (el) => {
    const parts = []
    let node = el
    let guard = 0
    while (node && node.nodeType === 1 && guard < 20) {
      parts.unshift(node.tagName.toLowerCase() + (node.id ? `#${node.id}` : ''))
      const root = rootOf(node)
      if (!root) break
      parts.unshift('#shadow-root')
      node = root.host
      guard += 1
    }
    return parts.join(' > ')
  }

  /** Query selector across the document plus every open shadow root. */
  const deepAll = (selector, root) => {
    const out = []
    const base = root || document
    const collect = (node) => {
      if (node && typeof node.querySelectorAll === 'function') {
        try {
          for (const el of node.querySelectorAll(selector)) out.push(el)
        } catch {
          /* invalid selector */
        }
      }
      if (node && node.nodeType === 1 && typeof node.matches === 'function') {
        try {
          if (node.matches(selector)) out.push(node)
        } catch {}
      }
    }
    collect(base)
    const stack = []
    const scan = (node) => {
      if (!node || typeof node.querySelectorAll !== 'function') return
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) stack.push(el.shadowRoot)
    }
    scan(base === document ? document : base)
    const seenRoots = new Set()
    while (stack.length > 0) {
      const shadow = stack.pop()
      if (seenRoots.has(shadow)) continue
      seenRoots.add(shadow)
      collect(shadow)
      scan(shadow)
    }
    return out
  }

  const deepQuery = (selector) => deepAll(selector)[0]

  /** topmost element at viewport point, descending into open shadow roots */
  const hitAt = (x, y) => {
    let el = document.elementFromPoint(x, y)
    let guard = 0
    while (el && el.shadowRoot && guard < 10) {
      let inner = null
      try {
        inner = typeof el.shadowRoot.elementFromPoint === 'function' ? el.shadowRoot.elementFromPoint(x, y) : null
      } catch {
        inner = null
      }
      if (!inner || inner === el) break
      el = inner
      guard += 1
    }
    return el
  }

  /** Is `el` actually the element that would receive a real click at its center? */
  const hitInfo = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return { hit: false, reason: '元素尺寸为 0，可能尚未渲染或已被隐藏' }
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const top = hitAt(x, y)
    if (!top) return { hit: false, reason: '该坐标上没有任何元素（页面可能滚动了）' }
    let node = top
    let guard = 0
    while (node && guard < 50) {
      if (node === el || (typeof el.contains === 'function' && el.contains(node))) return { hit: true, top }
      node = node.host ? node.host : node.parentNode
      guard += 1
    }
    return { hit: false, reason: '元素被其他元素遮挡', top }
  }

  /** Computed-style cache for this invocation (snapshot walks many ancestors). */
  const styleCache = new WeakMap()
  const styleOf = (node) => {
    let style = styleCache.get(node)
    if (style === undefined) {
      try {
        style = window.getComputedStyle(node)
      } catch {
        style = null
      }
      styleCache.set(node, style)
    }
    return style
  }

  /**
   * Walk the composed ancestor chain (crossing shadow boundaries) and reject
   * anything hidden by a parent. `display`/`visibility`/`opacity`/`inert`/
   * `aria-hidden` are checked on ancestors because they hide the whole subtree;
   * `pointer-events` is checked on the element itself only, since a descendant
   * may re-enable it with `pointer-events: auto`.
   */
  const hiddenByAncestor = (el) => {
    const own = styleOf(el)
    if (own && own.pointerEvents === 'none') return true
    let node = el
    let guard = 0
    while (node && node.nodeType === 1 && guard < 60) {
      if (node.hidden === true || (node.hasAttribute && node.hasAttribute('hidden'))) return true
      if (node.inert === true || (node.hasAttribute && node.hasAttribute('inert'))) return true
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return true
      const style = styleOf(node)
      if (style) {
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true
        if (style.contentVisibility === 'hidden') return true
        if (style.opacity !== '' && Number(style.opacity) === 0) return true
      }
      node = node.parentNode || (node.getRootNode && node.getRootNode().host)
      guard += 1
    }
    return false
  }

  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false
    if (hiddenByAncestor(el)) return false
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    if (rect.bottom < -200 || rect.top > window.innerHeight + 1000) return false
    return true
  }

  const textOf = (el) => {
    const aria = el.getAttribute && el.getAttribute('aria-label')
    if (aria) return norm(aria)
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      return norm(el.getAttribute('placeholder') || el.getAttribute('title') || el.value || '')
    }
    if (el.tagName === 'IMG') return norm(el.getAttribute('alt') || '')
    const inner = norm(el.innerText || el.textContent || '')
    if (inner) return inner.slice(0, MAX_TEXT)
    return norm(el.getAttribute('title') || el.getAttribute('name') || '')
  }

  const selectorFor = (el) => {
    const tag = el.tagName.toLowerCase()
    if (el.id) return `${tag}#${el.id}`
    const testId = el.getAttribute('data-testid')
    if (testId) return `${tag}[data-testid="${testId}"]`
    if (el.getAttribute('name')) return `${tag}[name="${el.getAttribute('name')}"]`
    return tag
  }

  const describe = (el, ref) => {
    if (!el || el.nodeType !== 1) return undefined
    const knownRef = ref || state.refOf.get(el)
    const info = {
      ref: knownRef || undefined,
      tag: el.tagName.toLowerCase(),
      selector: selectorFor(el),
      role: el.getAttribute('role') || undefined,
      type: el.getAttribute('type') || undefined,
      name: el.getAttribute('name') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      text: textOf(el).slice(0, MAX_TEXT),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    }
    if (el.id) info.id = el.id
    if (inShadow(el)) {
      info.inShadow = true
      info.shadowPath = shadowPath(el).slice(0, 200)
    }
    if (el.tagName === 'A' && el.href) info.href = String(el.href).slice(0, 300)
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') info.value = String(el.value ?? '').slice(0, 120)
    if (el.type === 'checkbox' || el.type === 'radio') info.checked = el.checked === true
    return info
  }

  const deepText = (root) => {
    const base = root || document.body
    if (!base) return ''
    let text = base.innerText || base.textContent || ''
    const shadowText = []
    const stack = []
    try {
      for (const el of base.querySelectorAll('*')) if (el.shadowRoot) stack.push(el.shadowRoot)
    } catch {}
    const seen = new Set()
    while (stack.length > 0) {
      const shadow = stack.pop()
      if (seen.has(shadow)) continue
      seen.add(shadow)
      shadowText.push(shadow.textContent || '')
      try {
        for (const el of shadow.querySelectorAll('*')) if (el.shadowRoot) stack.push(el.shadowRoot)
      } catch {}
    }
    if (shadowText.length > 0) text += '\n' + shadowText.join('\n')
    return text
  }

  const pageInfo = () => {
    const doc = document.documentElement
    return {
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: {
        x: window.scrollX,
        y: window.scrollY,
        width: Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0),
        height: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0),
      },
      readyState: document.readyState,
    }
  }

  const candidateSelector = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="combobox"]',
    '[role="switch"]',
    '[role="listbox"]',
    '[contenteditable="true"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',')

  const candidates = () => {
    const seen = new Set()
    const result = []
    for (const el of deepAll(candidateSelector)) {
      if (seen.has(el)) continue
      seen.add(el)
      if (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'hidden') continue
      if (!isVisible(el)) continue
      result.push(el)
    }
    return result
  }

  const resolve = (input) => {
    if (input && input.ref) {
      const ref = String(input.ref)
      const el = state.refs.get(ref)
      if (el && el.isConnected) return el
      throw fail(
        'ref_stale',
        `引用 ${ref} 已失效（快照代数 ${state.gen}；元素已被移除、页面已更新或不在当前框架）。请重新调用 browser_snapshot 获取新的 [eN] 引用。`,
      )
    }
    if (input && input.selector) {
      const el = deepQuery(String(input.selector))
      if (!el) throw fail('element_not_found', `选择器找不到元素：${input.selector}`)
      return el
    }
    if (input && input.text) {
      const needle = norm(input.text)
      const pool = candidates().filter((el) => {
        const t = norm(el.innerText || el.value || el.getAttribute('aria-label') || '')
        return t === needle || t.includes(needle)
      })
      if (pool.length === 0) throw fail('element_not_found', `找不到文本为「${input.text}」的可交互元素（已排除隐藏/透明/不可点击元素）`)
      pool.sort((a, b) => norm(a.innerText || '').length - norm(b.innerText || '').length)
      return pool[0]
    }
    throw fail('element_not_found', '需要 ref、selector 或 text 之一来定位元素')
  }

  const highlight = (el) => {
    try {
      const previous = el.style.outline
      el.style.outline = '2px solid #4f8cff'
      setTimeout(() => {
        el.style.outline = previous
      }, 350)
    } catch {
      /* ignore */
    }
  }

  const pointerInit = (el, buttonIndex, clickCount) => {
    const rect = el.getBoundingClientRect()
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: buttonIndex,
      buttons: buttonIndex === 0 ? 1 : buttonIndex === 1 ? 4 : 2,
      clickCount: clickCount || 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }
  }

  /** Dispatch the full pointer/mouse sequence a real click produces. */
  const fireClick = (el, buttonIndex, clickCount) => {
    el.scrollIntoView({ block: 'center', inline: 'center' })
    highlight(el)
    if (typeof el.focus === 'function') {
      try {
        el.focus({ preventScroll: true })
      } catch {}
    }
    const init = pointerInit(el, buttonIndex, clickCount)
    const pointer = (type) => {
      try {
        el.dispatchEvent(new PointerEvent(type, init))
      } catch {}
    }
    const mouse = (type) => {
      try {
        el.dispatchEvent(new MouseEvent(type, init))
      } catch {}
    }
    pointer('pointerdown')
    mouse('mousedown')
    pointer('pointerup')
    mouse('mouseup')
    if (buttonIndex === 0) {
      try {
        el.click()
      } catch {
        mouse('click')
      }
    } else if (buttonIndex === 2) {
      mouse('contextmenu')
    }
  }

  const hover = (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' })
    highlight(el)
    const rect = el.getBoundingClientRect()
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }
    const pointer = (type) => {
      try {
        el.dispatchEvent(new PointerEvent(type, init))
      } catch {}
    }
    const mouse = (type) => {
      try {
        el.dispatchEvent(new MouseEvent(type, init))
      } catch {}
    }
    mouse('mouseover')
    mouse('mouseenter')
    pointer('pointerover')
    pointer('pointerenter')
    pointer('pointermove')
    mouse('mousemove')
  }

  const nativeSetValue = (el, value) => {
    const previous = el.value
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : el instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : null
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : undefined
    try {
      if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, value)
      else el.value = value
    } catch {
      el.value = value
    }
    // React tracks the last known value; reset it so the synthetic input event is
    // seen as a real change by controlled components.
    if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
      try {
        el._valueTracker.setValue(previous)
      } catch {}
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const insertIntoEditable = (el, text) => {
    if (typeof el.focus === 'function') el.focus({ preventScroll: true })
    const selection = window.getSelection()
    if (typeof document.execCommand === 'function') {
      try {
        if (document.execCommand('insertText', false, text)) return true
      } catch {}
    }
    // Fallback for editors that block execCommand (ProseMirror/Slate/Quill).
    try {
      if (el.isContentEditable) {
        const range = document.createRange()
        range.selectNodeContents(el)
        selection.removeAllRanges()
        selection.addRange(range)
        const textNode = document.createTextNode(text)
        range.deleteContents()
        range.insertNode(textNode)
        range.collapse(false)
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
        return true
      }
    } catch {}
    return false
  }

  const pressEnter = (el) => {
    const target = el || document.activeElement || document.body
    const down = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    })
    target.dispatchEvent(down)
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
    if (!down.defaultPrevented && el && el.form && typeof el.form.requestSubmit === 'function') {
      try {
        el.form.requestSubmit()
      } catch {}
    }
  }

  const toMarkdown = (root) => {
    const inline = (node) => {
      if (node.nodeType === 3) return norm(node.textContent)
      if (node.nodeType !== 1) return ''
      const tag = node.tagName.toLowerCase()
      const inner = () => Array.from(node.childNodes).map(inline).join('')
      if (tag === 'br') return '\n'
      if (tag === 'a') {
        const label = inner() || norm(node.getAttribute('href'))
        return node.getAttribute('href') ? `[${label}](${node.getAttribute('href')})` : label
      }
      if (tag === 'img') return node.getAttribute('alt') ? `![${node.getAttribute('alt')}](${node.getAttribute('src')})` : ''
      if (tag === 'strong' || tag === 'b') return `**${inner()}**`
      if (tag === 'em' || tag === 'i') return `*${inner()}*`
      if (tag === 'code') return '`' + norm(node.textContent) + '`'
      return inner()
    }
    const block = (node) => {
      if (node.nodeType === 3) return norm(node.textContent)
      if (node.nodeType !== 1) return ''
      const tag = node.tagName.toLowerCase()
      const children = () => Array.from(node.childNodes).map(block).filter((s) => s !== '').join('\n\n')
      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
        return `${'#'.repeat(Number(tag[1]))} ${inline(node)}\n`
      }
      if (tag === 'p') return `${inline(node)}\n`
      if (tag === 'li') return `- ${inline(node)}\n`
      if (tag === 'ul' || tag === 'ol') {
        return Array.from(node.children)
          .filter((child) => child.tagName === 'LI')
          .map((child) => `- ${inline(child)}\n`)
          .join('')
      }
      if (tag === 'pre') return '```\n' + node.innerText.replace(/\n+$/, '') + '\n```\n'
      if (tag === 'blockquote') return '> ' + inline(node) + '\n'
      if (tag === 'hr') return '---\n'
      if (tag === 'table') {
        const rows = Array.from(node.querySelectorAll('tr'))
        if (rows.length === 0) return ''
        const cells = (row) => Array.from(row.children).map((cell) => inline(cell).replace(/\n/g, ' '))
        const header = cells(rows[0])
        const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
        for (const row of rows.slice(1)) lines.push(`| ${cells(row).join(' | ')} |`)
        return lines.join('\n') + '\n'
      }
      if (['script', 'style', 'noscript', 'template', 'iframe', 'svg'].includes(tag)) return ''
      if (['div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'form', 'aside'].includes(tag)) {
        const inner = children()
        return inner ? inner + '\n' : ''
      }
      return inline(node)
    }
    const text = Array.from(root.childNodes).map(block).join('\n')
    return text.replace(/\n{3,}/g, '\n\n').trim()
  }

  const result = await (async () => {
    if (op === 'snapshot') {
      // Clean up refs left by older extension versions that did write attributes.
      deepAll(`[${LEGACY_REF}]`).forEach((el) => el.removeAttribute(LEGACY_REF))
      state.refs.clear()
      state.refOf.clear()
      state.gen += 1
      const max = Math.max(1, Math.min(500, Number(params && params.maxElements) || 120))
      const pool = candidates()
      const elements = []
      let index = 0
      for (const el of pool) {
        if (elements.length >= max) break
        index += 1
        const ref = `e${index}`
        state.refs.set(ref, el)
        state.refOf.set(el, ref)
        elements.push(describe(el, ref))
      }
      const headings = []
      for (const el of deepAll('h1,h2,h3,h4,h5,h6')) {
        if (!isVisible(el)) continue
        const text = norm(el.innerText)
        if (!text) continue
        headings.push({ level: Number(el.tagName[1]), text: text.slice(0, 120) })
        if (headings.length >= 25) break
      }
      let preview
      if (!params || params.includeText !== false) {
        const bodyText = deepText(document.body)
        preview = bodyText.replace(/\n{3,}/g, '\n\n').slice(0, 2000)
      }
      const shadowHosts = deepAll('*').filter((el) => el.shadowRoot).length
      return {
        page: pageInfo(),
        generation: state.gen,
        elements,
        total: pool.length,
        truncated: pool.length > elements.length ? true : undefined,
        headings,
        textPreview: preview || undefined,
        shadowHosts: shadowHosts || undefined,
      }
    }

    if (op === 'click') {
      const el = resolve(params)
      el.scrollIntoView({ block: 'center', inline: 'center' })
      installProbe()
      const hit = hitInfo(el)
      if (!hit.hit && params.force !== true) {
        const blocker = hit.top ? describe(hit.top) : undefined
        const blockerText = blocker ? `，遮挡元素：<${blocker.tag}> ${blocker.text ? `"${blocker.text}"` : ''} ${blocker.selector}` : ''
        throw fail(
          'element_occluded',
          `${hit.reason}${blockerText}。已拒绝合成点击以避免误点；请先关闭弹窗/遮罩，或传 force:true 强制派发。`,
        )
      }
      fireClick(el, Number(params.button) || 0, Math.max(1, Number(params.clickCount) || 1))
      return {
        element: describe(el),
        trusted: state.lastInput ? state.lastInput.isTrusted === true : false,
        hitTest: hit.hit ? 'passed' : 'forced',
        generation: state.gen,
        page: pageInfo(),
      }
    }

    if (op === 'hover') {
      const el = resolve(params)
      hover(el)
      return { element: describe(el), hovered: true, page: pageInfo() }
    }

    if (op === 'type') {
      const el = resolve(params)
      el.scrollIntoView({ block: 'center' })
      highlight(el)
      installProbe()
      if (typeof el.focus === 'function') el.focus({ preventScroll: true })
      const text = String(params.text ?? '')
      const before = el.isContentEditable ? String(el.innerText ?? '') : String(el.value ?? '')
      const nextText = params.clear !== false ? text : before + text
      let inserted = false
      if (el.isContentEditable) {
        if (params.clear !== false) {
          try {
            const range = document.createRange()
            range.selectNodeContents(el)
            const selection = window.getSelection()
            selection.removeAllRanges()
            selection.addRange(range)
          } catch {}
        }
        inserted = insertIntoEditable(el, text)
        if (!inserted) {
          el.textContent = text
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
        }
      } else {
        try {
          el.dispatchEvent(
            new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: nextText }),
          )
        } catch {}
        nativeSetValue(el, nextText)
        inserted = true
      }
      if (params.pressEnter === true) pressEnter(el)
      return {
        element: describe(el),
        value: el.isContentEditable ? String(el.innerText ?? text) : String(el.value ?? ''),
        inserted,
        generation: state.gen,
        page: pageInfo(),
      }
    }

    if (op === 'select') {
      const el = resolve(params)
      const wantedValue = params.value === undefined ? undefined : String(params.value)
      const wantedLabel = params.label === undefined ? undefined : norm(params.label)
      if (el.tagName === 'SELECT') {
        el.scrollIntoView({ block: 'center' })
        const options = Array.from(el.options || [])
        const option = options.find((opt) => {
          if (wantedValue !== undefined && String(opt.value) === wantedValue) return true
          if (wantedLabel !== undefined && norm(opt.textContent) === wantedLabel) return true
          return false
        })
        if (!option) {
          throw fail(
            'element_not_found',
            `原生 select 中找不到目标选项（value=${wantedValue ?? '未提供'}，label=${wantedLabel ?? '未提供'}）。已有选项：${options.map((o) => o.textContent).join(' | ').slice(0, 300)}`,
          )
        }
        nativeSetValue(el, option.value)
        return {
          element: describe(el),
          selected: { value: option.value, label: norm(option.textContent) },
          native: true,
          page: pageInfo(),
        }
      }
      // Custom dropdown (Ant Design / Element UI / headless UI …): open, wait for
      // the menu to mount, then click the matching option. Handles portal menus
      // and virtual lists by scrolling option containers when nothing matches.
      const needle = wantedLabel ?? wantedValue ?? ''
      if (!needle) throw fail('element_not_found', '自定义下拉框需要 label 或 value 来匹配选项')
      el.scrollIntoView({ block: 'center' })
      installProbe()
      fireClick(el, 0, 1)

      const findOption = () => {
        const pool = candidates().filter((cand) => {
          if (cand === el) return false
          const t = norm(cand.innerText || cand.getAttribute('aria-label') || '')
          return t === needle || t.includes(needle)
        })
        if (pool.length > 0) {
          pool.sort((a, b) => norm(a.innerText || '').length - norm(b.innerText || '').length)
          return pool[0]
        }
        const direct = deepAll('[role="option"],[role="menuitem"],li,.ant-select-item-option,.el-select-dropdown__item')
          .filter((cand) => isVisible(cand) && cand !== el)
          .find((cand) => norm(cand.innerText || '').includes(needle))
        return direct || null
      }

      const startedAt = Date.now()
      const deadline = startedAt + Math.max(300, Math.min(6000, Number(params.optionTimeoutMs) || 2500))
      let chosen = findOption()
      let attempts = 0
      while (!chosen && Date.now() < deadline) {
        attempts += 1
        // Virtual list / long menu: scroll the option container to load more items.
        for (const box of deepAll('[role="listbox"],ul,.ant-select-dropdown,.el-select-dropdown').filter(isVisible)) {
          try {
            box.scrollTop += Math.max(80, Math.round(box.clientHeight * 0.8))
          } catch {}
        }
        await sleep(120)
        chosen = findOption()
      }
      if (!chosen) {
        throw fail(
          'element_not_found',
          `下拉框已展开，但找不到包含「${needle}」的选项（耗时 ${Date.now() - startedAt}ms，尝试 ${attempts} 次）。请确认选项文本，或改用 browser_eval 直接触发组件的 change。`,
        )
      }
      chosen.scrollIntoView({ block: 'nearest' })
      fireClick(chosen, 0, 1)
      return {
        element: describe(el),
        selected: { label: norm(chosen.innerText || '') },
        native: false,
        attempts,
        generation: state.gen,
        page: pageInfo(),
      }
    }

    if (op === 'pressKey') {
      const el = params.ref || params.selector ? resolve(params) : document.activeElement || document.body
      highlight(el)
      const key = String(params.key ?? '')
      const modifiers = Array.isArray(params.modifiers) ? params.modifiers.map((m) => String(m).toLowerCase()) : []
      const init = {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true,
        cancelable: true,
        ctrlKey: modifiers.includes('control') || modifiers.includes('ctrl'),
        shiftKey: modifiers.includes('shift'),
        altKey: modifiers.includes('alt'),
        metaKey: modifiers.includes('meta') || modifiers.includes('command'),
      }
      if (key === 'Enter') {
        init.keyCode = 13
        init.which = 13
      }
      const down = new KeyboardEvent('keydown', init)
      el.dispatchEvent(down)
      el.dispatchEvent(new KeyboardEvent('keyup', init))
      if (key === 'Enter' && el.form && typeof el.form.requestSubmit === 'function' && !down.defaultPrevented) {
        try {
          el.form.requestSubmit()
        } catch {}
      }
      return { key, element: el === document.body ? undefined : describe(el), page: pageInfo() }
    }

    if (op === 'scroll') {
      const direction = String(params.direction || 'down')
      const amount = Math.abs(Number(params.pixels) || 600)
      const container = params.ref || params.selector ? resolve(params) : null
      const horizontal = direction === 'left' || direction === 'right'
      const target = container
        ? container
        : direction === 'top' || direction === 'bottom'
          ? document.scrollingElement || document.documentElement
          : window
      const metric = (() => {
        if (target === window) {
          return {
            left: window.scrollX,
            top: window.scrollY,
            width: document.documentElement.scrollWidth - window.innerWidth,
            height: document.documentElement.scrollHeight - window.innerHeight,
          }
        }
        return {
          left: target.scrollLeft,
          top: target.scrollTop,
          width: target.scrollWidth - target.clientWidth,
          height: target.scrollHeight - target.clientHeight,
        }
      })()
      if (horizontal) {
        let left = metric.left
        if (direction === 'left') left -= amount
        else left += amount
        left = Math.max(0, left)
        if (target === window) window.scrollTo({ left, behavior: 'instant' })
        else target.scrollLeft = left
        return {
          scroll: { direction, left: target === window ? window.scrollX : target.scrollLeft, height: metric.width, page: pageInfo() },
          page: pageInfo(),
        }
      }
      let top
      if (direction === 'top') top = 0
      else if (direction === 'bottom') top = metric.height
      else if (direction === 'up') top = metric.top - amount
      else top = metric.top + amount
      top = Math.max(0, top)
      if (target === window) window.scrollTo({ top, behavior: 'instant' })
      else target.scrollTo({ top, behavior: 'instant' })
      return {
        scroll: { direction, top: target === window ? window.scrollY : target.scrollTop, height: metric.height, page: pageInfo() },
        page: pageInfo(),
      }
    }

    if (op === 'drag') {
      const mouseButton = String(params.button || 'left').toLowerCase()
      const buttonIndex = mouseButton === 'right' ? 2 : mouseButton === 'middle' ? 1 : 0
      const buttonsMask = buttonIndex === 2 ? 2 : buttonIndex === 1 ? 4 : 1
      const steps = Math.max(1, Math.min(120, Math.round(Number(params.steps) || 12)))
      const duration = Math.max(0, Math.min(10000, Number(params.durationMs) || 400))
      const holdMs = Math.max(0, Math.min(5000, Number(params.holdMs) || 60))

      const pointOf = (ref, selector, x, y, label) => {
        if (ref || selector) {
          const el = resolve(ref ? { ref } : { selector })
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
          const rect = el.getBoundingClientRect()
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, el }
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error(`需要 ${label}X/${label}Y 或 ${label}Ref/${label}Selector 指定拖动${label === 'from' ? '起点' : '终点'}`)
        }
        const el = hitAt(x, y) || document.body
        return { x, y, el }
      }

      const from = pointOf(params.fromRef, params.fromSelector, Number(params.fromX), Number(params.fromY), 'from')
      const to = pointOf(params.toRef, params.toSelector, Number(params.toX), Number(params.toY), 'to')

      // Native HTML5 drag-and-drop (dragstart/dragover/drop) cannot be produced by
      // synthetic pointer events; emulate it when requested.
      if (params.html5 === true) {
        const dataTransfer = new DataTransfer()
        const seed = params.text === undefined ? '' : String(params.text)
        if (seed) dataTransfer.setData('text/plain', seed)
        const dnd = (target, type, x, y) => {
          const rect = target.getBoundingClientRect()
          const event = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            dataTransfer,
            clientX: x === undefined ? rect.left + rect.width / 2 : x,
            clientY: y === undefined ? rect.top + rect.height / 2 : y,
          })
          target.dispatchEvent(event)
          return event
        }
        highlight(from.el)
        dnd(from.el, 'dragstart')
        for (let i = 1; i <= steps; i += 1) {
          const ratio = i / steps
          dnd(hitAt(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio) || to.el, 'dragover', from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio)
          if (duration > 0) await sleep(duration / steps)
        }
        dnd(to.el, 'drop', to.x, to.y)
        dnd(from.el, 'dragend')
        return {
          drag: {
            from: { x: Math.round(from.x), y: Math.round(from.y), element: describe(from.el) },
            to: { x: Math.round(to.x), y: Math.round(to.y), element: describe(to.el) },
            mode: 'html5',
          },
          page: pageInfo(),
        }
      }

      const baseInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: buttonIndex,
        buttons: buttonsMask,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }
      const fire = (target, type, x, y, buttons) => {
        const init = { ...baseInit, clientX: x, clientY: y, buttons }
        try {
          target.dispatchEvent(new PointerEvent(type, init))
        } catch {
          /* PointerEvent 不可用时只发鼠标事件 */
        }
        if (type.startsWith('pointer')) {
          const mouseType = type === 'pointerdown' ? 'mousedown' : type === 'pointerup' ? 'mouseup' : 'mousemove'
          target.dispatchEvent(new MouseEvent(mouseType, init))
        }
        return init
      }

      highlight(from.el)
      fire(from.el, 'pointerdown', from.x, from.y, buttonsMask)
      let last = { x: from.x, y: from.y }
      for (let i = 1; i <= steps; i += 1) {
        const ratio = i / steps
        const x = from.x + (to.x - from.x) * ratio
        const y = from.y + (to.y - from.y) * ratio
        const hovered = hitAt(x, y) || document.body
        fire(hovered, 'pointermove', x, y, buttonsMask)
        last = { x, y }
        if (duration > 0) await sleep(duration / steps)
      }
      if (holdMs > 0) await sleep(holdMs)
      const dropped = hitAt(to.x, to.y) || to.el
      fire(dropped, 'pointerup', last.x, last.y, 0)
      fire(dropped, 'click', last.x, last.y, 0)
      return {
        drag: {
          from: { x: Math.round(from.x), y: Math.round(from.y), element: describe(from.el) },
          to: { x: Math.round(to.x), y: Math.round(to.y), element: describe(dropped) },
          steps,
          durationMs: duration,
          button: mouseButton,
        },
        page: pageInfo(),
      }
    }

    if (op === 'extract') {
      const root = params.selector ? deepQuery(String(params.selector)) : document.body
      if (!root) throw new Error(`选择器找不到元素：${params.selector}`)
      const format = String(params.format || 'text')
      let content
      if (format === 'html') content = root.innerHTML
      else if (format === 'links') {
        content = deepAll('a[href]', root)
          .map((a) => `${norm(a.innerText) || '(无文字)'} -> ${a.href}`)
          .join('\n')
      } else if (format === 'markdown') content = toMarkdown(root)
      else content = deepText(root)
      const maxChars = Math.max(100, Math.min(200000, Number(params.maxChars) || 20000))
      const truncated = content.length > maxChars
      return {
        format,
        content: truncated ? content.slice(0, maxChars) : content,
        truncated,
        page: pageInfo(),
      }
    }

    if (op === 'eval') {
      const expression = String(params.expression ?? '')
      let value
      try {
        value = new Function(`"use strict"; return (${expression});`)()
      } catch (firstError) {
        try {
          value = new Function(expression)()
        } catch (secondError) {
          const message = secondError instanceof Error ? secondError.message : String(secondError)
          throw new Error(`无法执行表达式（可能是页面 CSP 禁止 eval，或表达式存在语法错误）：${message}`)
        }
      }
      const finish = (resolved) => {
        let type = typeof resolved
        let safe
        try {
          if (resolved === undefined) {
            safe = null
            type = 'undefined'
          } else if (type === 'bigint') {
            safe = String(resolved)
            type = 'bigint'
          } else if (type === 'function') {
            safe = String(resolved).slice(0, 500)
            type = 'function'
          } else if (type === 'symbol') {
            safe = String(resolved)
            type = 'symbol'
          } else {
            safe = JSON.parse(JSON.stringify(resolved))
          }
        } catch (error) {
          safe = String(resolved).slice(0, 2000)
          type = 'unserializable'
        }
        return { result: safe, resultType: type }
      }
      if (params.awaitPromise !== false && value && typeof value.then === 'function') {
        const awaited = await value
        return finish(awaited)
      }
      return finish(value)
    }

    if (op === 'waitCheck') {
      const requestedState = String(params.state || 'visible')
      let present = false
      let visible = false
      let count = 0
      let textFound = false
      if (params.selector) {
        const matched = deepAll(String(params.selector))
        count = matched.length
        present = count > 0
        visible = matched.some((el) => isVisible(el))
      }
      if (params.text) {
        const needle = norm(params.text)
        textFound = deepText(document.body).includes(needle)
      }
      let found
      if (requestedState === 'hidden') found = params.selector ? !visible : !textFound
      else if (requestedState === 'attached') found = present
      else if (requestedState === 'detached') found = !present
      else found = params.selector ? visible : textFound
      return {
        matched: found,
        state: requestedState,
        present,
        visible,
        count,
        textFound,
        page: pageInfo(),
      }
    }

    if (op === 'activity') {
      let resources = 0
      try {
        resources = performance.getEntriesByType('resource').length
      } catch {}
      return {
        readyState: document.readyState,
        resources,
        now: Math.round(performance.now()),
        visibility: document.visibilityState,
        page: pageInfo(),
      }
    }

    if (op === 'elementBox') {
      const el = resolve(params)
      el.scrollIntoView({ block: 'center', inline: 'center' })
      installProbe()
      const rect = el.getBoundingClientRect()
      const hit = hitInfo(el)
      const round = (value) => Math.round(value * 100) / 100
      return {
        element: describe(el),
        point: { x: round(rect.left + rect.width / 2), y: round(rect.top + rect.height / 2) },
        box: { x: round(rect.left), y: round(rect.top), width: round(rect.width), height: round(rect.height) },
        hit: { hit: hit.hit, reason: hit.reason, top: describe(hit.top) },
        generation: state.gen,
        page: pageInfo(),
      }
    }

    if (op === 'focus') {
      const el = resolve(params)
      el.scrollIntoView({ block: 'center', inline: 'center' })
      highlight(el)
      installProbe()
      if (typeof el.focus === 'function') el.focus({ preventScroll: true })
      return {
        element: describe(el),
        focused: document.activeElement === el,
        value: String(el.value ?? '').slice(0, 200),
        page: pageInfo(),
      }
    }

    if (op === 'inputProbe') {
      return {
        lastInput: state.lastInput ?? null,
        generation: state.gen,
        page: pageInfo(),
      }
    }

    if (op === 'scrollInto') {
      const el = resolve(params)
      el.scrollIntoView({ block: params.align === 'start' ? 'start' : 'center', inline: 'nearest' })
      await sleep(60)
      const rect = el.getBoundingClientRect()
      return {
        element: describe(el),
        inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
        top: Math.round(rect.top),
        page: pageInfo(),
      }
    }

    if (op === 'scrollFind') {
      const needle = String(params.text ?? '')
      if (!needle) throw fail('element_not_found', 'scrollFind 需要 text 参数')
      const container = params.ref || params.selector ? resolve(params) : null
      const target = container || document.scrollingElement || document.documentElement
      const isPage = !container || target === document.scrollingElement || target === document.documentElement
      const direction = String(params.direction || 'down').toLowerCase() === 'up' ? -1 : 1
      const maxSteps = Math.max(1, Math.min(200, Number(params.maxSteps) || 20))
      const viewport = isPage ? window.innerHeight : target.clientHeight || window.innerHeight
      const step = Math.abs(Number(params.pixels) || Math.max(120, Math.round(viewport * 0.8))) * direction
      const scan = () => deepText(isPage ? document.body : target).includes(needle)
      let matched = scan()
      let steps = 0
      for (let i = 0; i < maxSteps && !matched; i += 1) {
        steps = i + 1
        if (isPage) window.scrollBy({ top: step, behavior: 'instant' })
        else target.scrollTop += step
        await sleep(120)
        matched = scan()
      }
      return { matched, text: needle, steps, atTop: isPage ? window.scrollY <= 0 : target.scrollTop <= 0, page: pageInfo() }
    }

    if (op === 'readValue') {
      const el = resolve(params)
      return {
        element: describe(el),
        value: el.isContentEditable ? String(el.innerText ?? '') : String(el.value ?? ''),
        checked: el.checked === true || el.getAttribute('aria-checked') === 'true',
        generation: state.gen,
        page: pageInfo(),
      }
    }

    if (op === 'pageInfo') return { page: pageInfo() }

    throw new Error(`未知的页面操作：${op}`)
  })()

  return result
}

export { }
