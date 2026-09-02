# 大肥鱼 · 使用说明

透明置顶的桌面小鲸鱼：显示 LLM 余额、聊天、本地分流省额度、文件读写与生成 docx/pdf/pptx/xlsx、本地生图。**没有显卡也能用**（余额 + 云端聊天即可），进阶功能按需开启。

## 对话来源

| 来源 | 用途 | 需要 |
| --- | --- | --- |
| Codex | 深度干活 / 审代码 | 装了 Codex CLI |
| 本地 | 用本机模型，省额度 | 本地服务（LM Studio / Ollama 等）|
| 云端 | 填 Key 即用 | 任意 OpenAI 兼容接口 |

## 快速开始

1. 解压到**不含中文/空格**的路径
2. 右键小鲸鱼 →「设置」→ 填 API Key
3. 按 `Alt+Q` 开对话 → 顶部选「云端」即可

## 进阶功能（默认关，在对话工具条开 `🧩` / `⚡`）

- **分流**：先把 `chat-workspace\config.local.json` 配好（`llmBaseUrl`、模型、`localWhitelist`），再开「⚡分流」
- **文件 / 扩展 MCP**：文件与文档生成是**内置**，开 `🧩` 即用；网络搜索 / 浏览器 / Windows / MySQL 需在 `config.json` 的 `mcps` 配，见 [README 的 MCP 小节](../README.md#mcp-工具)
- **生图**：配好 ComfyUI（`comfyPy` / `comfyDir` / `comfyCli`）即可；与文本模型显存互斥，防爆显存

更完整的字段与示例见 [配置教程](配置教程.md)。

## 注意

- `config.json` / `config.local.json` 含密钥与本机路径，勿上传或分享
- 本地文件工具只允许白名单目录；高危操作会弹确认框
- `windows-mcp` / `playwright` 属高危工具，仅在信任来源下开启

使用愉快~
