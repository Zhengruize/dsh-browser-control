const $ = (id) => document.getElementById(id)

const dot = $('dot')
const stateText = $('stateText')
const detailText = $('detailText')
const serverUrl = $('serverUrl')
const token = $('token')
const autoReconnect = $('autoReconnect')
const version = $('version')
const browserName = $('browser')

let polling

function render(status) {
  if (!status) return
  dot.className = 'dot ' + (status.state === 'connected' ? 'connected' : status.state === 'connecting' ? 'connecting' : status.error ? 'error' : '')
  stateText.textContent =
    status.state === 'connected' ? '已连接 DSH' : status.state === 'connecting' ? '正在连接…' : status.state === 'error' ? '连接失败' : '未连接'
  detailText.textContent = status.error || status.socketUrl || ''
  if (document.activeElement !== serverUrl) serverUrl.value = status.settings?.serverUrl ?? ''
  if (document.activeElement !== token) token.value = status.settings?.token ?? ''
  if (document.activeElement !== autoReconnect) autoReconnect.checked = status.settings?.autoReconnect !== false
  version.textContent = `v${status.version ?? ''}`
  browserName.textContent = status.browser ?? ''
}

async function refresh() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'dsh-browser-popup', action: 'status' })
    render(status)
  } catch (error) {
    detailText.textContent = String(error)
  }
}

async function send(action, extra = {}) {
  const status = await chrome.runtime.sendMessage({ type: 'dsh-browser-popup', action, ...extra })
  render(status)
  return status
}

serverUrl.addEventListener('change', () => send('save', { settings: { serverUrl: serverUrl.value.trim() } }))
token.addEventListener('change', () => send('save', { settings: { token: token.value } }))
autoReconnect.addEventListener('change', () => send('save', { settings: { autoReconnect: autoReconnect.checked } }))

$('connectBtn').addEventListener('click', () => send('connect'))
$('disconnectBtn').addEventListener('click', () => send('disconnect'))
$('settingsForm').addEventListener('submit', (event) => {
  event.preventDefault()
  send('save', {
    settings: {
      serverUrl: serverUrl.value.trim(),
      token: token.value,
      autoReconnect: autoReconnect.checked,
    },
  })
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'dsh-browser-state') refresh()
})

refresh()
polling = setInterval(refresh, 1500)
window.addEventListener('unload', () => clearInterval(polling))
