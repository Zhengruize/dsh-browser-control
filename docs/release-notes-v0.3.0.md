# dsh-browser-control v0.3.0

DSH 插件 + Chrome/Edge 扩展，让模型直接操作你已登录的真实浏览器。

## 安装

```bash
git clone https://github.com/Zhengruize/dsh-browser-control.git
```

在 DSH 对话里让 agent 执行 `plugin_manager` → `install_bundle` → `target: <克隆路径>`，然后在 `chrome://extensions` 加载 `extension` 目录，把 `~/.dsh/.browser-control-token` 的内容粘贴到扩展弹窗的令牌框。

详见 [README](README.md)。

## 本版要点

- CDP 可信输入（`real: true`，`isTrusted=true`）
- 引用不再写入 DOM，反检测
- 祖先级可见性过滤 + 遮挡命中检测（`element_occluded`）
- open Shadow DOM / iframe 穿透，`frameId` 全工具支持
- `networkidle` 等待、结构化错误码、失败自动截图证据
- `browser_drag` / `browser_hover` / `browser_select` / 语义化滚动

完整记录见 [CHANGELOG](CHANGELOG.md)。
