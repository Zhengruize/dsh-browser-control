import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply, name } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))

const registered = []
const byName = new Map()
const ctx = {
  effect(fn) {
    const dispose = fn()
    return dispose
  },
  logger: () => ({ info() {} }),
  tools: {
    register(tool) {
      registered.push(tool)
      if (byName.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`)
      byName.set(tool.name, tool)
    },
    get(n) {
      return byName.get(n)
    },
  },
  systemPrompt: { section() {} },
}

apply(ctx, { port: 17444 })
console.log('plugin name:', name)
console.log('tool count:', byName.size)
console.log('tools:', [...byName.keys()].join(', '))

// Every render must survive a null canonical value (the reported crash).
const nullSafe = []
for (const [toolName, tool] of byName) {
  const render = tool.output?.render
  if (typeof render !== 'function') continue
  try {
    const out = render({}, null)
    const text = Array.isArray(out) ? out.map((p) => p?.text ?? '').join(' ') : String(out)
    if (!text || text.length === 0) nullSafe.push(`${toolName}:empty`)
    else if (/渲染失败/.test(text)) nullSafe.push(`${toolName}:fallback`)
  } catch (error) {
    nullSafe.push(`${toolName}:THREW(${error instanceof Error ? error.message : error})`)
  }
}
console.log('render(null) problems:', nullSafe.length === 0 ? 'none' : nullSafe.join(' ; '))

// Parameter schemas must be plain JSON-serializable objects.
for (const [toolName, tool] of byName) {
  try {
    JSON.stringify(tool.parameters ?? {})
  } catch (error) {
    console.log(`schema not serializable: ${toolName}`, error.message)
  }
}

if (nullSafe.length > 0) process.exit(1)
console.log('registration check passed')
process.exit(0)
