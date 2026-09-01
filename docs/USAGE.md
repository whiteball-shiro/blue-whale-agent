# 大肥鱼 · 使用说明书

## 它是什么

透明置顶的桌面小鲸鱼，能显示 LLM 余额、陪你聊天、分流省额度、读文件/生成 docx/pdf/pptx、本地生图，还能扩展 MCP（网络搜索/浏览器/系统）。

> **没有显卡也能用**：只开「余额 + 云端聊天」即可，本地/生图都是可选进阶。

## 对话来源（顶部三个按钮）

| 来源 | 干什么 | 需要 |
| --- | --- | --- |
| Codex | 深度干活、审代码 | 装了 Codex CLI |
| 本地 | 用自己电脑的模型，免费省额度 | 本地模型（LM Studio/Ollama 等）|
| 云端 | 填 Key 就能聊 | 任意 OpenAI 兼容接口 |

Codex 下拉会自动读取你本机配置的模型；本地下拉列出全部语言模型（自动过滤 embedding）。

## 第一次用

1. 解压到不含中文/空格路径。
2. 右键小鲸鱼 → 设置 → 填 API Key（DeepSeek 或任意兼容服务）。
3. 打开对话（`Alt+Q`）→ 选「云端」即可聊。

## 设置里的「对话与模型」

右键 → 设置 → 往下找到「对话与模型」，可直接改默认来源、云端 API 地址/Key/模型名、本地服务地址。本地服务支持任意 OpenAI 兼容接口（设 LM Studio/Ollama 预设或手填），留空用 LM Studio 默认。

## 进阶功能

### 分流（省额度）
填好 `chat-workspace\config.local.json`（`llmBaseUrl`、`localModelId`、`localWhitelist`），开启「⚡分流」开关。

### 白名单（本地文件能访问哪些目录）
复制 `chat-workspace\config.local.json.example` 为 `chat-workspace\config.local.json`，在 `localWhitelist` 数组里填允许访问的目录（如 `["D:\\工作", "C:\\Users\\me\\Documents"]`）。白名单之外一律拒绝；`COM:WORKSPACE` 等占位符会自动解析成实际目录。

### 文件 MCP / 扩展 MCP
写在主配置 `config.json` 的 `mcps` + `mcpServersOn`。`config.example.json` 已给 qwen-files、web-search、playwright、windows-mcp 示例。

> `windows-mcp`/`playwright` 是高危工具，桌宠默认会**弹确认框 + 写文件前自动备份**，请只在信任的模型来源下开启。

### 生图
需要 ComfyUI，配置 `comfyPy / comfyDir / comfyCli` 后即可。文本与生图互斥，防爆显存。

## 注意

- `config.json` 和 `config.local.json` 含密钥/真实路径，**不要提交**。
- 本地文件工具仅限白名单目录；危险操作会弹确认。
- 关掉 LM Studio 后，只剩 Codex / 云端能用。

祝你使用愉快，让大肥鱼陪着你~
