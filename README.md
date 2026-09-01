# 大肥鱼

> 一只会悬浮在你桌面、能陪你聊天、帮你盯 DeepSeek API 余额、还能本地生图和处理文件的小鲸鱼。

![演示](assets/demo.gif)

桌宠 + 通用 LLM 对话 + 本地模型分流（省额度）+ 本地生图 + 文件工具。**没有显卡也能用**（DeepSeek 余额 + 云端聊天），有显卡再解锁本地分流/生图。

---

## 功能

**基础（开箱即用，只需填一个 API Key）**

- 透明置顶、Q 弹的小鲸鱼桌面宠物，实时显示 DeepSeek API 余额

- 云端对话（任意 OpenAI 兼容接口：DeepSeek / OpenRouter / SiliconFlow / LM Studio 等）

- 三种对话来源：**Codex**（需装 Codex，能深度干活/审代码）、**本地**（用自己电脑的模型，免费省额度）、**云端**（填 Key 即用）。Codex 模型下拉会自动读取你本机 Codex 配置的模型（不限于 DeepSeek）。

- 可自定义宠物形象、余额名称、缩放、点击穿透、闲置半透明、开机自启等



**进阶（可选，默认关，不影响基础功能）**

- 本地委派分流：把翻译/总结/润色/写删改/生成 PPT 文档等子任务交给本地模型，节省云端额度

- 本地文件 MCP：在白名单目录内读写、生成 docx / pdf / pptx

- 扩展 MCP（示例已内置）：网络搜索（web-search）、操控浏览器（playwright）、操控 Windows（windows-mcp）——**本地与云端对话都能调用同一套 MCP**

- 本地生图：一键调用 ComfyUI，文本/生图显存自动互斥防爆

- 剪贴板识图、截屏共享、看图、工具开关、思考开关、显存条



---

## 快速开始

1. 下载发布版（GitHub Releases），解压到不含中文/空格的路径。

2. (可选) 运行 `setup.bat` 自动写入配置、注册 Poppler、创建快捷方式。

3. 右键小鲸鱼 →「设置」→ 填入你的 API Key。

4. 打开对话（默认快捷键 `Alt+Q`）→ 顶部选「云端」即可用；想省额度可选「本地」。

> **没有显卡也能用**：只开 DeepSeek 余额 + 云端聊天即可。本地分流/生图是可选进阶功能。

---

## 配置

> 想从头配置？看「[配置教程](docs/配置教程.md)」——字段说明、云端/本地示例、常见问题都在里面。后面只列要点。

复制 `config.example.json` 为 `config.json`，按需填写。

- **通用 LLM**：填 `llmBaseUrl + llmApiKey + llmModel` 即可接任意 OpenAI 兼容服务，不限于 DeepSeek。

- **余额显示**：默认读取 DeepSeek 的 `https://api.deepseek.com/user/balance`，并按其返回格式解析；`balanceUrl` 可改地址，但需要返回相同结构，因此目前主要针对 DeepSeek（聊天接口才是不绑定的）。

- **本地来源不绑死**：`localBaseUrl` 控制「本地」来源连的本地推理服务地址，支持任意 OpenAI 兼容接口。留空默认用 LM Studio 端口（`http://127.0.0.1:1234/v1`）；想换 Ollama 等填 `http://127.0.0.1:11434/v1` 即可。

- **本地模型列表**：用 LM Studio 时，桌宠会通过它的 CLI（`lms ls`）列出**磁盘上全部**语言模型（含未加载的），并过滤掉 embedding；用其它本地服务（Ollama / llama.cpp）时走 `/v1/models` 接口，干净的名字原样保留。

- **本地模型可配置**：`localModelFilter` 控制挑哪个本地模型（默认 qwen，可改 llama/qwen3 等），`localModelPath`/`localModelMmproj` 填你自己模型的路径。

- **本地模型目录**：`localModelDir` 用于读取本地 gguf 的上下文上限（防止历史太长卡死），留空则自动从 `localModelPath` 推导。本地进阶所需的 `llmBaseUrl / localWhitelist / workspaceDir` 等建议写在 `chat-workspace\config.local.json`（该文件已被 .gitignore 忽略）。

- **进阶特性默认关**：`chatLocalRoute / chatMcp` 默认 false，只有你想省额度/用文件/生图时才打开。

---

## 本地进阶（可选）

需要 Node.js 18+，以及（按需）：任意 OpenAI 兼容的本地推理服务（LM Studio / Ollama / llama.cpp / vLLM 等）+ 一个支持工具调用的本地模型、ComfyUI（本地生图）。相关脚本在 `chat-workspace/`，路径已在 `config.example.json` 参数化，占位符请按你的机器填写。

**白名单怎么加**：本地文件工具只允许读写你指定的目录。复制 `chat-workspace/config.local.json.example` 为 `chat-workspace/config.local.json`，在 `localWhitelist` 数组里填你想让本地模型访问的目录（如 `["D:\\工作", "C:\\Users\\me\\Documents"]`）。白名单之外的一律拒绝；`COM:WORKSPACE` 等占位符会被自动解析成实际目录。

**MCP 配置说明**：桌宠的 MCP 服务器统一写在主配置 `config.json` 的 `mcps` 数组 + `mcpServersOn` 开关里。`config.example.json` 已给出 qwen-files、web-search、playwright、windows-mcp 四个示例：

- `COM:NODE_BIN` → 你的 node 可执行文件路径
- `COM:WEB_SEARCH_MCP` → web-search MCP 的入口 js 路径
- `COM:UVX_BIN` → uvx 可执行文件路径
- `COM:CHAT_WORKSPACE` → 桌宠对话工作目录

`windows-mcp`、`playwright` 是**高危工具**（能执行命令、操控系统/浏览器、跑页面代码）。桌宠默认对这类工具**弹确认框 + 写文件前自动备份**，请只在信任的模型来源下开启。

---

## 目录

`resources/` 桌宠主程序源码；`chat-workspace/` 本地委派/文件 MCP/生图脚本与规则；`config.example.json` 配置模板；`setup.bat` 一键安装；`docs/` 说明书（[docs/USAGE.md](docs/USAGE.md) · [配置教程](docs/配置教程.md)）。

---

## 安全与合规

- 本仓库不含任何真实密钥/个人路径（已脱敏为占位符）；你自己的 `config.json`（含 API Key/聊天记录）不要提交。

- 本地模型的文件工具仅限白名单目录读写、不能执行终端/联网/数据库；生图与文本模型显存互斥。

- 仅供学习交流，请遵守 DeepSeek / OpenAI / 各开源项目许可与条款；使用风险自负。

---

## 跨平台说明

核心桌宠（Electron）可跨平台；`chat-workspace/` 里的本地脚本（PowerShell + GPU）目前为 Windows 专属可选模块，Mac/Linux 上可直接用基础。

---

## 构建 / 发布

**开发调试**（需要 Node.js 18+，在 `resources/` 目录执行）：

```bash
cd resources
npm install        # 安装 Electron 等依赖
npx electron .     # 运行桌宠
```

**打包成 exe**（在 `resources/` 目录执行）：

```bash
cd resources
npm i -D electron-builder
npx electron-builder --win
```

打包成功后，安装包会生成在 `resources\dist\` 目录下（文件名形如 `deepseek-whale-pet Setup <版本>.exe`），把它上传到 GitHub Release 即可。

> 免安装绿色版在 `resources\dist\win-unpacked\`，可整套文件夹拷给朋友直接运行。
> 如果你只是给内网/朋友用，也可以直接复制 `resources/` 目录，用 `npx electron .` 运行，无需打包。

---

## 致谢与来源

本项目是开源衍生作品，遵循 MIT 许可。来源链如下：

- **MeteorNOX / DeepSeek-Balance-Whale-Widget**（MIT，[仓库](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)）—— 最初的 DSH 网页余额挂件。
- **qijiamin0822 / deepseek-whale-pet**（MIT，[仓库](https://github.com/qijiamin0822/deepseek-whale-pet)）—— 把上述挂件改造成独立桌面桌宠，也是本项目的直接基础。
- **本仓库（大肥鱼）** —— 在前者的基础上做的泛化改造（通用 LLM、本地委派、文件 MCP、本地生图等）。

> MIT 要求衍生作品保留各上游的版权声明与许可声明，详见 [LICENSE](LICENSE)。

同时感谢 Electron / Poppler / LM Studio / ComfyUI / DeepSeek 等社区项目与所有开源贡献者。



*使用愉快，让大肥鱼陪你~*
