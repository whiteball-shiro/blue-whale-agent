#!/usr/bin/env node
// 本地 qwen3.5-9b 委派助手：供 Codex 模式下的智能体调用。
// 参数沿用现有本地设置：temperature 0.5 / max_tokens 2048 / 不思考（reasoning_effort: none）。
// 文件工具通过 MCP 提供：本脚本启动 _qwen_mcp_server.mjs，按 MCP(stdio/JSON-RPC) 协议
// 获取工具并执行调用。白名单来自 config.local.json 的 localWhitelist（未配置用安全占位符）
// 由 MCP 服务器强制校验，白名单外路径一律拒绝。

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const MCP_SERVER = path.join(SCRIPT_DIR, '_qwen_mcp_server.mjs')
// 从 config.local.json 读取本地 LLM 配置（通用 base_url / 模型筛选 / api-key），没有则回退本地 LM Studio
let CFG = {}
try { const p = path.join(SCRIPT_DIR, 'config.local.json'); if (fs.existsSync(p)) CFG = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) {}
const BASE_URL = String(CFG.llmBaseUrl || 'http://127.0.0.1:1234/v1').replace(/\/+$/, '')
const API = BASE_URL + '/chat/completions'
const MODELS_URL = BASE_URL + '/models'
const API_KEY = String(CFG.llmApiKey || '')
// 委派模型过滤：默认通用（只要不是 embedding 即可）。若显式设置 localModelFilter 才按它挑。
const _RAW_FILTER = String(CFG.localModelFilter || '').trim()
const MODEL_FILTER = (_RAW_FILTER && !/^(any|all|\*)$/i.test(_RAW_FILTER)) ? new RegExp(_RAW_FILTER, 'i') : null

// 白名单目录：从 config.local.json.localWhitelist 读取，未填用安全占位符，绝不写死用户真实路径
const DEFAULT_WHITELIST = ['COM:WORKSPACE', 'COM:USERHOME\\Documents', 'COM:USERHOME\\Desktop']
const WHITELIST = (Array.isArray(CFG.localWhitelist) && CFG.localWhitelist.length ? CFG.localWhitelist : DEFAULT_WHITELIST)
  .map((p) => String(p).replace(/^COM:WORKSPACE$/i, path.resolve(SCRIPT_DIR, '..', '..')).replace(/^COM:USERHOME/i, os.homedir()))
const WHITELIST_TEXT = WHITELIST.join('、')

const SYSTEM_PROMPT =
  '你是桌宠「大肥鱼」，性格呆萌可爱、有点憨，回答要直接、简洁、口语化，**尽量少用表情符号/emoji**。不要使用任何联网工具。' +
  '你可以使用 MCP 文件系统工具（list_dir / read_file / write_file / delete_file / create_docx / create_pdf / create_pptx）' +
  '在以下目录内读写删改：' + WHITELIST_TEXT + '。白名单之外的路径会被系统拒绝。'

function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of String(text)) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++
    else if (!/\s/.test(ch)) other++
  }
  return Math.ceil(cjk + other / 3.6)
}

function getMaxCtx() {
  // 读正在运行的 llama-server 的 --ctx-size（LM Studio 实际生效的上下文上限）
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'llama-server.exe' } | Select-Object -First 1 -ExpandProperty CommandLine"], { encoding: 'utf8', windowsHide: true })
    const m = /--ctx-size\s+(\d+)/.exec(out || '')
    if (m) return parseInt(m[1], 10)
  } catch (err) { /* ignore */ }
  return 32768
}

// 委派前自动去重：脚本直启的 llama-server 若与 LM Studio 托管实例并存，自动清理冗余直启实例
function dedupeLlamaServers() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPT_DIR, 'whale-gpu.ps1'), 'dedupe'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    const msg = String(out || '').trim()
    if (msg) process.stderr.write('[qwen llama dedupe] ' + msg.replace(/\n/g, ' ') + '\n')
  } catch (err) {
    process.stderr.write('[qwen llama dedupe] failed: ' + String(err && err.message || err) + '\n')
  }
}

async function pickModel() {
  try {
    const headers = API_KEY ? { Authorization: 'Bearer ' + API_KEY } : {}
    const r = await fetch(MODELS_URL, { headers, signal: AbortSignal.timeout(3000) })
    const j = await r.json()
    const ids = ((j && j.data) || []).map((x) => x.id).filter((id) => !/(embedding|embed|nomic-embed|bge-|gte-)/i.test(id) && (!MODEL_FILTER || MODEL_FILTER.test(id)))
    if (CFG.localModelId) return ids.find((id) => String(id).toLowerCase().includes(String(CFG.localModelId).toLowerCase())) || ids[0] || ''
    return ids[0] || ''
  } catch { return '' }
}

// ---- MCP stdio 客户端（JSON-RPC 2.0，逐行消息） ----
class McpClient {
  constructor() {
    this.child = null
    this.rl = null
    this.pending = new Map()
    this.nextId = 1
  }

  start() {
    this.child = spawn(process.execPath, [MCP_SERVER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child.stderr.on('data', (d) => process.stderr.write('[mcp] ' + String(d)))
    this.rl = readline.createInterface({ input: this.child.stdout })
    this.rl.on('line', (line) => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (msg && msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message || 'MCP error'))
        else resolve(msg.result)
      }
    })
    this.child.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error('MCP server exited: ' + code))
      this.pending.clear()
    })
  }

  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  request(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('MCP request timeout: ' + method))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v) },
        reject: (e) => { clearTimeout(t); reject(e) },
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  async init() {
    this.start()
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'local-qwen', version: '1.0.0' },
    }, 10000)
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  async listTools() {
    const res = await this.request('tools/list', {}, 10000)
    return (res && res.tools) || []
  }

  async callTool(name, args) {
    const res = await this.request('tools/call', { name, arguments: args || {} }, 90000)
    const content = (res && res.content) || []
    return { text: content.map((c) => c.text || '').join('\n'), isError: !!(res && res.isError) }
  }

  stop() {
    try { if (this.child) this.child.kill() } catch { /* ignore */ }
  }
}

async function chatOnce(model, messages, toolsPayload) {
  const body = {
    model,
    messages,
    stream: false,
    temperature: 0.5,
    max_tokens: 2048,
    reasoning_effort: 'none',
  }
  if (toolsPayload && toolsPayload.length) {
    body.tools = toolsPayload
    body.tool_choice = 'auto'
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, API_KEY ? { Authorization: 'Bearer ' + API_KEY } : {}),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const j = await res.json()
  const m = j && j.choices && j.choices[0] && j.choices[0].message
  return { text: (m && m.content) || '', toolCalls: (m && m.tool_calls) || [] }
}

async function main() {
  const q = process.argv.slice(2).join(' ').trim()
  if (!q) { process.stdout.write('（没有收到问题）'); return }

  dedupeLlamaServers()
  const maxCtx = getMaxCtx()
  const budget = maxCtx - 900

  // 连接 MCP 获取工具（失败则降级为纯文本对话）
  const mcp = new McpClient()
  let toolsPayload = null
  try {
    await mcp.init()
    const tools = await mcp.listTools()
    toolsPayload = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: String(t.description || '').slice(0, 200), parameters: t.inputSchema || { type: 'object', properties: {} } },
    }))
    process.stderr.write('[mcp] tools loaded: ' + tools.length + '\n')
  } catch (err) {
    process.stderr.write('[mcp] unavailable, degrade to text-only: ' + String(err && err.message || err) + '\n')
    toolsPayload = null
  }

  const schemaCost = toolsPayload && toolsPayload.length ? estimateTokens(JSON.stringify(toolsPayload)) + 40 : 0
  const used = estimateTokens(q) + 24 + schemaCost
  if (used > budget) {
    process.stdout.write('（本地模型上下文不足：输入约 ' + used + ' tokens，上下文上限 ' + maxCtx + ' tokens，安全预算 ' + budget + '。任务内容过长，请自行完成或截断后再委派）')
    process.exit(1)
  }

  const model = await pickModel()
  if (!model) { process.stdout.write('（本地模型不可用：请确认 LM Studio 已加载 Qwen 模型并启动服务）'); process.exit(1) }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: q },
  ]

  try {
    const MAX_ROUNDS = 4
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const out = await chatOnce(model, messages, toolsPayload)
      const tcs = out.toolCalls || []
      if (!tcs.length) {
        process.stdout.write(out.text || '（本地模型没有返回内容）')
        return
      }
      messages.push({
        role: 'assistant',
        content: out.text || '',
        tool_calls: tcs.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: (tc.function && tc.function.name) || '',
            arguments: typeof (tc.function && tc.function.arguments) === 'string'
              ? tc.function.arguments
              : JSON.stringify((tc.function && tc.function.arguments) || {}),
          },
        })),
      })
      for (const tc of tcs) {
        let args = {}
        try { args = JSON.parse((tc.function && tc.function.arguments) || '{}') } catch { /* ignore */ }
        const name = (tc.function && tc.function.name) || ''
        const r = await mcp.callTool(name, args)
        messages.push({ role: 'tool', tool_call_id: tc.id, content: r.text })
        process.stderr.write('[qwen MCP 工具 ' + name + '] ' + String(r.text).replace(/\n/g, ' ') + '\n')
      }
    }
    process.stdout.write('（工具调用轮次过多，已停止）')
  } catch (err) {
    process.stdout.write('（本地模型调用失败：' + (err && err.message || err) + '）')
    process.exitCode = 1
  } finally {
    mcp.stop()
  }
}

main()
