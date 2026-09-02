# 大肥鱼

会悬浮在桌面、陪你聊天、盯 DeepSeek 余额，还能本地分流、生图和生成文件的小鲸鱼桌宠。**没有显卡也能用**（云端聊天 + 余额），有显卡再解锁本地模型 / 生图。

![演示](assets/demo.gif)

## 功能

- **基础**：透明置顶桌宠、DeepSeek 余额显示、云端对话（任意 OpenAI 兼容接口）、自定义形象 / 缩放 / 穿透 / 开机自启
- **本地分流**：把翻译 / 总结 / 生成文档等交给本地模型，省云端额度
- **文件工具（内置）**：白名单目录内读写、生成 docx / pdf / pptx / xlsx
- **生图**：本地 ComfyUI 生成，与文本模型显存互斥防爆显存
- **剪贴板识图、截屏共享、看图、思考开关、显存条**

## 快速开始

1. 下载 [Release](https://github.com/whiteball-shiro/blue-whale-agent/releases)，解压到**不含中文/空格**的路径
2. （可选）运行 `setup.bat`
3. 右键小鲸鱼 →「设置」→ 填 API Key
4. 按 `Alt+Q` 打开对话，顶部选「云端」即可；想省额度选「本地」

进阶功能（分流 / MCP / 生图）默认关：开对话后点左侧 `🧩`（MCP）和 `⚡分流`，或在 `config.json` 设 `chatMcp`、`chatLocalRoute` 为 `true`。

## 快捷键

| 热键 | 作用 |
| --- | --- |
| `Alt+Q` | 打开 / 关闭对话（可改） |
| `Ctrl+Shift+X` | 鼠标穿透 |
| `Ctrl+Shift+H` | 显示 / 隐藏桌宠 |
| `Ctrl+Shift+R` | 刷新余额 |

对话框内：`Enter` 发送，`Shift+Enter` 换行。

## 配置

复制 `config.example.json` 为 `config.json`，按需填：

- `apiKey`：DeepSeek Key（余额显示用）
- `llmBaseUrl` / `llmApiKey` / `llmModel`：任意 OpenAI 兼容云端服务
- `localBaseUrl`：本地推理地址（默认 LM Studio `http://127.0.0.1:1234/v1`，Ollama 填 `.../11434/v1`）

本地相关（模型路径、白名单等）写在 `chat-workspace\config.local.json`，见 [配置教程](docs/配置教程.md)。

## MCP 工具

**内置（开 🧩 即用，无需配置）**：文件读写、生成 docx/pdf/pptx/xlsx、生图。

**外部 MCP 需要配**：网络搜索、浏览器（playwright）、Windows 操控、MySQL。在 `config.json` 的 `mcps` 数组里加对应条目，并在 `mcpServersOn` 里设 `true`。

### 网络搜索（web-search）

需要 node + 一个 web-search MCP 入口 js（例如 [web-search-mcp](https://github.com/idosal/agent-client-utils/tree/main/legacy/web-search-mcp)）。

```json
{
  "id": "web-search",
  "name": "网络搜索",
  "command": "D:\\nodejs\\node.exe",
  "args": ["D:\\tools\\web-search-mcp\\dist\\index.js"],
  "env": {},
  "localReadOnly": false
}
```

把 `command` / `args` 换成你本机 node.exe 和入口 js 的真实路径。

### 浏览器（playwright）

需要 Node.js，首次使用会自动拉取 playwright 包。

```json
{
  "id": "playwright",
  "name": "浏览器",
  "command": "npx",
  "args": ["@playwright/mcp@latest"],
  "env": {},
  "localReadOnly": false
}
```

### Windows 操控（windows-mcp）

需要先安装 `uvx`（Python 生态）：

```bash
pip install uv
uvx windows-mcp --help
```

```json
{
  "id": "windows-mcp",
  "name": "Windows 操控",
  "command": "D:\\Python\\Scripts\\uvx.exe",
  "args": ["windows-mcp", "serve"],
  "env": {},
  "localReadOnly": false
}
```

`command` 换成你本机 uvx.exe 的真实路径。

### MySQL（查询 / 增删改）

```json
{
  "id": "mysql",
  "name": "MySQL",
  "command": "npx",
  "args": ["-y", "@benborla29/mcp-server-mysql"],
  "env": {
    "MYSQL_HOST": "localhost",
    "MYSQL_PORT": "3306",
    "MYSQL_USER": "root",
    "MYSQL_PASS": "你的密码",
    "MYSQL_DB": "库名",
    "ALLOW_INSERT_OPERATION": "true",
    "ALLOW_UPDATE_OPERATION": "true",
    "ALLOW_DELETE_OPERATION": "false",
    "ALLOW_DDL_OPERATION": "false"
  },
  "localReadOnly": false
}
```

> ⚠️ MySQL 写删改不会弹确认框。建议用只读账号，或把 `ALLOW_DELETE_OPERATION` / `ALLOW_DDL_OPERATION` 设为 `false`，切勿对生产库开放删改。

### 开启

把上面某个条目的 `id` 加进 `mcpServersOn` 并设 `true`：

```json
"mcpServersOn": { "web-search": true, "playwright": true, "windows-mcp": true, "mysql": false }
```

> ⚠️ playwright / windows-mcp 属高危工具（能开浏览器 / 执行命令），仅在信任的对话来源下开启。

## 本地进阶（可选）

需要 Node.js 18+ 和任意 OpenAI 兼容本地服务（LM Studio / Ollama / llama.cpp 等）+ 支持工具调用的模型；生图还需 ComfyUI。详见 [配置教程](docs/配置教程.md) 的「本地」与「生图」章节。

本地文件工具默认**只允许** `config.local.json` 的 `localWhitelist` 里列出的目录（支持 `COM:WORKSPACE` 等占位符自动解析），白名单外一律拒绝。

## 安全与合规

- `config.json` / `config.local.json` 含 Key 与本机路径，**勿上传公开仓库**
- 本地文件工具仅白名单内读写，不能执行终端 / 联网 / 数据库
- 文本模型与生图显存互斥，防止小显存同时跑两个大模型

## 构建 / 发布

```bash
cd resources
npm install
npx electron-builder --win
```

安装包生成在 `resources\dist\`，绿色版在 `resources\dist\win-unpacked\`。

## 来源与致谢

本仓库是对 [qijiamin0822/deepseek-whale-pet](https://github.com/qijiamin0822/deepseek-whale-pet)（源自 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)）的泛化改造，遵循 MIT。详见 [LICENSE](LICENSE)。感谢 Electron / Poppler / LM Studio / ComfyUI / DeepSeek 等社区。
