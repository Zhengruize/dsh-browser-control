# dsh-browser-control

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-bundle-blue)](https://github.com/Zhengruize/dsh-browser-control)

让 **DeepSeek Harness (DSH)** 直接控制你自己的 Chrome / Edge 浏览器：
打开网页、读取页面结构、点击、悬停、输入、下拉选择、滚动、拖拽、等待、截图、执行 JS。

由两部分组成：

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| DSH 插件（Host 侧） | `lib/` | 在 `127.0.0.1:17373` 启动 WebSocket 桥，向模型注册 `browser_*` 工具 |
| 浏览器扩展（Manifest V3） | `extension/` | 连接插件，用你自己的登录态执行标签页 / DOM / 截图操作 |

```
模型 ──browser_* 工具──> DSH 插件 ──WebSocket(127.0.0.1)──> 浏览器扩展 ──chrome.* / script──> 你的浏览器
```

## 功能

- **真实浏览器**：复用你已登录的 Chrome/Edge 会话，不是无头沙箱浏览器。
- **15 个模型工具**：状态、标签页、导航、快照、点击、悬停、下拉选择、输入、按键、滚动、拖动、提取、截图、JS、等待。
- **能进 iframe 与 Shadow DOM**：快照穿透 open Shadow DOM；元素操作在主框架找不到时自动回退到子框架，也可显式传 `frameId`。
- **适配纯 JS 渲染**：`waitUntil: networkidle` 等 AJAX 渲染稳定；React 受控输入会重置 `_valueTracker`。
- **可信输入（可选）**：`browser_click` / `browser_type` 传 `real: true` 时改用 CDP 的 `Input.dispatchMouseEvent` / `Input.insertText`，产生 `isTrusted=true` 的真实输入；结果里会回显 `isTrusted` 实际值。
- **失败带证据**：元素类操作失败时会自动截图并回传路径；错误带 `element_not_found` / `ref_stale` / `element_occluded` 代码。
- **默认安全**：只监听 `127.0.0.1`；扩展必须携带令牌握手的 WebSocket 才能接入。
- **纯本地**：不依赖云端服务，插件与扩展之间只有本机回环连接。

## 快速开始

### 第 1 步：安装 bundle 到 DSH profile

本目录是一个 DSH 插件 **bundle**（`cordis.patch.yml` + `dsh.bundle.patch` 声明）。先克隆本仓库：

```bash
git clone https://github.com/Zhengruize/dsh-browser-control.git
cd dsh-browser-control
```

推荐用 DSH 内置的 `plugin_manager` 安装（依赖会一并装好），不要手工改 profile 的 `package.json` / `cordis.patch.yml`：

> 在 DSH 对话中让 agent 执行：
> `plugin_manager` → `action: install_bundle` → `target: <本仓库克隆后的绝对路径>`

安装成功会返回 `application: "applied"`，此时插件立即生效（`browser_*` 工具已注册），无需重启。

如果安装结果提示 `restart-required`，重启一次 DSH 即可。

<details>
<summary>手工安装（不推荐，仅用于排查）</summary>

1. 把本目录链接到 `%USERPROFILE%\.dsh\profiles\node_modules\dsh-browser-control`（需要 `ws` 可解析，例如在本目录先 `npm install`）。
2. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 追加：

```yaml
- id: browser-control
  name: dsh-browser-control
```

3. 重启 DSH。
</details>

### 第 2 步：加载浏览器扩展并配对令牌

插件首次启动时会**自动生成一个随机令牌**写入 `~/.dsh/.browser-control-token`（Windows 为 `C:\Users\<你>\.dsh\.browser-control-token`）。仓库里不再内置默认令牌。

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
2. 打开右上角 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择本目录下的 `extension` 文件夹。
4. 点击工具栏中的扩展图标，确认：
   - 服务器地址：`ws://127.0.0.1:17373`
   - 访问令牌：粘贴 `~/.dsh/.browser-control-token` 的内容（或在插件配置里显式设置的 `token`）
   - 点击 **连接**，状态变为 **已连接 DSH**。

> 也可以直接在 DSH 里说「把 browser-control 的 token 给我」，模型会读该文件并告诉你。

### 第 3 步：验证

在 DSH 对话中让模型调用 `browser_status`，看到「连接状态：已连接」即可；也可以直接说：

> 打开 https://example.com，读取页面结构，然后截图。

## 配置

插件配置写在 profile patch 的 `config` 里，例如：

```yaml
- id: browser-control
  name: dsh-browser-control
  config:
    port: 17373
    token: ""
    commandTimeoutMs: 30000
    screenshotDir: ""
    allowEval: true
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `port` | `17373` | 本地 WebSocket 监听端口 |
| `token` | 空（自动生成） | 扩展握手令牌。留空时首次启动随机生成并持久化到 `~/.dsh/.browser-control-token`；填值则固定使用该值，需与扩展弹窗一致 |
| `commandTimeoutMs` | `30000` | 单条浏览器命令超时 |
| `screenshotDir` | 空（系统临时目录） | 截图保存目录 |
| `allowEval` | `true` | 是否允许 `browser_eval` |

扩展端在弹窗里可以修改服务器地址、令牌和自动重连。

## 工具一览

| 工具 | 说明 |
| --- | --- |
| `browser_status` | 连接状态、扩展版本、当前活动标签页 |
| `browser_tabs` | `list` / `open` / `activate` / `close` 标签页 |
| `browser_navigate` | 打开 URL 并等待加载（`load` / `domcontentloaded` / `networkidle` / `none`，可加 `waitFor` 选择器） |
| `browser_snapshot` | 页面结构快照：可交互元素带 `[eN]` 引用、标题、正文预览；穿透 open Shadow DOM，列出子 iframe 的 `frameId` |
| `browser_click` | 按 `ref` / CSS 选择器 / 可见文本点击；默认合成事件，`real: true` 走 CDP 可信点击（`isTrusted=true`）；带遮挡检测，被遮住时报 `element_occluded` |
| `browser_hover` | 悬停元素，展开 JS 驱动的二级菜单 / 悬浮提示 |
| `browser_select` | 选择下拉框：原生 `<select>` 与 Ant Design / Element UI 等自定义下拉框都支持；会等待菜单挂载并处理虚拟滚动 |
| `browser_type` | 向输入框、文本域、contenteditable 输入文本（兼容 React 受控组件）；`real: true` 走 CDP 可信输入 |
| `browser_press_key` | 派发键盘按键（Enter、Escape、方向键等，支持修饰键） |
| `browser_scroll` | 滚动页面/容器（`up` / `down` / `top` / `bottom` / `left` / `right`）；`toRef` 滚到元素；`untilText` 边滚边找（虚拟列表） |
| `browser_drag` | 模拟鼠标按住并拖动：起点按下 → 分步移动 → 松开（坐标或元素引用）；`html5: true` 走原生拖放事件 |
| `browser_extract` | 提取 `text` / `markdown` / `html` / `links` |
| `browser_screenshot` | 截取可视区域为 PNG，返回文件路径 |
| `browser_eval` | 在页面执行 JS 表达式（可用 `world: main` 访问页面变量） |
| `browser_wait` | 等待元素或文本出现 / 消失 |

推荐的工作流：

```
browser_status → browser_navigate → browser_snapshot
   → browser_click / browser_type → browser_snapshot（引用会刷新）
   → browser_extract / browser_screenshot 核对结果
```

快照里的 `[e1]`、`[e2]` 只对产生它的页面状态有效；点击、跳转或页面异步更新后要重新 `browser_snapshot`。引用保存在扩展内存里，不会写进 DOM 属性，页面脚本看不到自动化痕迹。

## 兼容性与已知限制

| 场景 | 现状 |
| --- | --- |
| 纯 JS 渲染 / SPA | 支持。`browser_navigate` 用 `waitUntil: "networkidle"`，或 `browser_wait` 等目标选择器出现；不要只依赖 `load` |
| open Shadow DOM（Web Components） | 支持：快照、点击、输入、文本提取都会穿透，结果里带 `shadow` 标记（`markdown` 格式仍只处理 light DOM） |
| closed Shadow DOM（`attachShadow({mode:'closed'})`） | 无法穿透（浏览器不向页面外暴露） |
| iframe | 支持：主框架找不到元素时自动尝试子框架；`browser_snapshot` 会列出 `frameId`，所有工具都可传 `frameId` 指定框架 |
| React / Vue 受控输入 | 已重置 `_valueTracker` 并派发 `input`/`change`；极少数自己拦截 `beforeinput` 的编辑器可能仍需 `browser_eval` 兜底 |
| hover 菜单 | `browser_hover` 能触发 JS 监听；无法产生真实 CSS `:hover` 状态，纯 CSS 菜单请改用点击或 `browser_eval` |
| 自定义下拉框 | `browser_select` 会点击展开、等待菜单挂载（包括 portal 与虚拟滚动再滚动查找），按可见文本匹配 |
| `isTrusted` 检查 | 默认合成事件 `isTrusted=false`；传 `real: true` 走 CDP 可信输入，可绕过检查（会短暂出现「正在调试此浏览器」提示条） |
| 原生 HTML5 拖放 | `browser_drag` 传 `html5: true` 派发 `dragstart`/`dragover`/`drop`；检查 `isTrusted` 的站点需要 CDP 版本 |
| 文件上传 | 未支持：`<input type="file">` 会弹系统对话框，需要 `chrome.debugger` 的 `DOM.setFileInputFiles`，暂未开放该命令 |
| 截图 | 需要标签页在前台且窗口未最小化；失败会返回明确提示，可改用 `browser_extract` |
| `file://` 页面 | 需在扩展详情里打开「允许访问文件网址」 |

### 错误代码

元素类操作失败时，错误信息以 `[code]` 开头，便于模型分支处理：

| 代码 | 含义 | 处理建议 |
| --- | --- | --- |
| `element_not_found` | 找不到元素（已排除隐藏/透明/不可点击元素） | 重新快照；确认文本或选择器；子框架要传 `frameId` |
| `ref_stale` | `[eN]` 引用已失效（页面更新或元素被销毁） | 重新 `browser_snapshot` |
| `element_occluded` | 元素被弹窗/遮罩/浮层挡住 | 先关闭遮罩；确实要点击时传 `force: true` |

## 安全说明

- WebSocket 服务只绑定 `127.0.0.1`，不会暴露到局域网。
- 扩展连接时必须携带与插件一致的 token，否则会被拒绝。
- 扩展拥有 `<all_urls>` 权限与页面脚本注入能力，请只在信任的本机环境中安装。
- 扩展声明了 `debugger` 权限，仅在 `real: true` 的可信输入路径下附加标签页，并在命令结束后立即 `detach`；期间浏览器会显示调试提示条。
- `browser_eval` 可在页面执行任意 JS；不需要时把 `allowEval` 设为 `false`。
- 浏览器扩展运行在你的浏览器配置中，因此**能访问你已登录的网站**，请勿把网页内容当作指令执行。

## 目录结构

```
dsh-browser-control/
├─ lib/
│  ├─ index.js          # 插件入口：配置、生命周期、system prompt 引导
│  ├─ bridge.js         # WebSocket 桥：握手、令牌校验、命令/响应、重连
│  └─ tools.js          # 15 个 browser_* 工具定义与结果渲染
├─ extension/
│  ├─ manifest.json      # Manifest V3
│  ├─ background.js      # Service Worker：连接桥、分发命令
│  ├─ page-functions.js  # 注入页面的快照 / 点击 / 输入 / 提取 / eval 逻辑
│  ├─ popup.html/css/js  # 连接状态与设置界面
│  └─ icons/             # 扩展图标
├─ scripts/
│  ├─ make-icons.py      # 重新生成图标
│  └─ selftest.mjs       # 端到端自测（本地 HTTP 测试页 + 自动拉起 Edge）
├─ test/                 # 自测页面
└─ README.md
```

## 排障

| 现象 | 处理 |
| --- | --- |
| 模型看不到 `browser_*` 工具 | 用 `plugin_manager` 的 `install_bundle` 重新安装本目录，确认返回 `application: "applied"`；若为 `restart-required` 则重启一次 DSH |
| `browser_status` 显示未连接 | 扩展弹窗点「连接」；核对端口；令牌粘贴 `~/.dsh/.browser-control-token` 的内容；确认没有其他程序占用 17373 |
| 点击/输入无效或报「引用已失效」 | 页面已更新，重新 `browser_snapshot` 获取新引用 |
| 元素在弹窗/iframe/自定义组件里找不到 | 先看 `browser_snapshot` 输出的「子框架」列表并传 `frameId`；自定义组件在 open Shadow DOM 内时快照会带 `shadow` 标记 |
| 点击没反应、报 `element_occluded` | 有遮罩层，先关掉它（如弹窗、Cookie 提示）；确实要强行派发时传 `force: true` |
| 站点不响应点击/输入（`isTrusted=false`） | 传 `real: true` 走 CDP 可信输入；若提示被其他调试器占用，先关掉 DevTools |
| SPA 页面快照是空的 | 用 `browser_navigate` 的 `waitUntil: "networkidle"`，或 `browser_wait` 等某个选择器出现后再快照 |
| 某个页面无法注入脚本 | `chrome://`、Edge 商店、PDF 等受限页面不支持，切换到普通网页 |
| 扩展连接后很快断开 | 查看扩展弹窗错误；确认 DSH 进程仍在运行；保持浏览器扩展启用 |
| 端口冲突 | 修改插件配置 `port` 和扩展弹窗中的服务器地址，保持一致 |

## 卸载

让 DSH agent 执行 `plugin_manager` → `action: remove_bundle` → `target: dsh-browser-control`，然后在扩展管理页移除扩展即可。

## 已知限制

- closed Shadow DOM（`mode:'closed'`）无法穿透，浏览器不对外暴露。
- `real: true` 需要标签页未被 DevTools 或其他调试器占用；期间会出现调试提示条。
- 截图是可视区域，不含整页长截图。
- 文件上传（`<input type="file">`）尚未提供命令。
- 浏览器扩展在 Chrome/Edge 116+ 上测试。
- 修改插件配置后，Desktop profile 需要重启一次 DSH 才会生效（bundle 安装本身通常即时生效）。

## 开发 / 自测

```bash
pnpm install          # 或 npm install

# 离线结构校验（不需要浏览器，不需要 DSH）
npm run verify        # 工具注册 + render 空安全 + 命令/操作覆盖 + 权限声明

# 端到端自测（可选）：本地起测试页，自动拉起 Edge 加载扩展跑一遍所有工具
node scripts/selftest.mjs
# 可用 DSH_SELFTEST_BROWSER 指定浏览器路径、DSH_SELFTEST_WS_PORT 指定测试端口
```

自测会启动本地 HTTP 测试页、调用 `apply()`（与 DSH 相同的 Cordis 插件契约）、拉起 Edge 无头模式加载扩展，并逐项验证各工具。

## License

[Apache-2.0](LICENSE)
