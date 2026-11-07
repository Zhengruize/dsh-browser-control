# Changelog

## v0.3.0

- **可信输入**：`browser_click` / `browser_type` 新增 `real: true`，走 CDP `Input.dispatchMouseEvent` / `Input.insertText`，产生 `isTrusted=true` 事件；结果回显实际 isTrusted。
- **不再污染 DOM**：元素引用 `[eN]` 存于扩展内存 Map，页面无法通过 `data-*` 属性检测到自动化痕迹。
- **可见性收紧**：过滤祖先继承的 `opacity:0`、`pointer-events:none`、`aria-hidden`、`inert`、`hidden`；点击前做 `elementFromPoint` 命中检测，被遮挡报 `element_occluded`。
- **Shadow DOM / iframe**：快照穿透 open Shadow DOM（带 `shadowPath`）；列出子框架，所有工具支持 `frameId`，元素定位自动回退子框架。
- **SPA 适配**：`browser_navigate` 支持 `waitUntil: networkidle` 与 `waitFor` 选择器；`browser_wait` 支持 `attached/detached`。
- **组件支持**：`browser_select` 处理原生与自定义下拉框（等待挂载、portal、虚拟滚动）；`browser_hover`；`browser_drag` 支持指针与 HTML5 拖放两种模式；`browser_scroll` 支持滚到元素、滚动查找文本。
- **健壮性**：结构化错误码（`element_not_found` / `ref_stale` / `element_occluded`）、引用代数 generation、失败自动附截图证据、渲染层空值安全。
- **安全**：默认令牌改为首次启动随机生成并持久化到 `~/.dsh/.browser-control-token`，仓库不再内置固定令牌。

## v0.2.0

- iframe 自动回退与 `frameId`；Shadow DOM 穿透；`networkidle`；`browser_drag`/`browser_hover`/`browser_select` 初版。
