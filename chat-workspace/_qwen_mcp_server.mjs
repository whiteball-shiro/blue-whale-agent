#!/usr/bin/env node
// _qwen_mcp_server.mjs — 本地 qwen 文件系统 MCP 服务器（stdio / JSON-RPC，无外部依赖）
// 提供文件工具（list_dir / read_file / write_file / delete_file）和文档构建工具
// （create_docx / create_pdf / create_pptx），白名单目录之外一律拒绝。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
let CFG = {}
try { const p = path.join(SCRIPT_DIR, 'config.local.json'); if (fs.existsSync(p)) CFG = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) {}
// COM:WORKSPACE 占位符解析：优先取 config.local.json.workspaceDir，其次取脚本上级目录（resources 所在目录）的上两级，最后取用户主目录
function workdirFallback() {
  const w = String((CFG && CFG.workspaceDir) || '').trim()
  if (w) return w
  try {
    const up = path.resolve(SCRIPT_DIR, '..', '..')
    if (fs.existsSync(up)) return up
  } catch (e) {}
  return os.homedir()
}
// 白名单从 config.local.json.localWhitelist 读取；未填时用安全的占位符（安装/配置向导会替换），绝不写死用户真实路径
const DEFAULT_WHITELIST = ['COM:WORKSPACE', 'COM:USERHOME\\Documents', 'COM:USERHOME\\Desktop']
const ALLOWED_ROOTS = (Array.isArray(CFG.localWhitelist) && CFG.localWhitelist.length ? CFG.localWhitelist : DEFAULT_WHITELIST)
  .map((p) => String(p).replace(/^COM:WORKSPACE$/i, workdirFallback()).replace(/^COM:USERHOME/i, os.homedir()))
  .map((p) => path.resolve(p))

const TOOLS = [
  {
    name: 'list_dir',
    description: '列出目录下的文件和子目录',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径' } },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: '读取文本文件内容',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '创建新文件或覆盖写入已有文本文件',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的完整文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: '删除单个文件',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
  },
  {
    name: 'create_docx',
    description: '在指定路径创建 Word 文档（.docx），内容为给定文本',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（.docx）' },
        text: { type: 'string', description: '文档内容' },
      },
      required: ['path', 'text'],
    },
  },
  {
    name: 'create_pdf',
    description: '在指定路径创建 PDF 文件，内容为给定文本',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（.pdf）' },
        text: { type: 'string', description: '文档内容' },
      },
      required: ['path', 'text'],
    },
  },
  {
    name: 'create_pptx',
    description: '在指定路径创建 PowerPoint 演示文稿（.pptx）。可用 text+slides 每页显示相同文本；或传入 slides_text 字符串数组，每项为一页内容（首行为标题，- 开头行为要点），生成各页不同的演示文稿',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（.pptx）' },
        text: { type: 'string', description: '每页显示的内容' },
        slides: { type: 'integer', description: '页数，默认 1' },
        slides_text: { type: 'array', items: { type: 'string' }, description: '每页内容数组，每项：第一行标题，后续 - 开头行为要点（可选，优先于 text+slides）' },
      },
      required: ['path'],
    },
  },
]

function safeResolve(p) {
  if (!p || typeof p !== 'string') return { ok: false, reason: '路径为空' }
  let abs
  try { abs = path.resolve(p) } catch { return { ok: false, reason: '路径无效' } }
  const norm = abs.toLowerCase()
  for (const root of ALLOWED_ROOTS) {
    const rn = root.toLowerCase()
    if (norm === rn) return { ok: true, abs, isRoot: true }
    if (norm.startsWith(rn + path.sep)) return { ok: true, abs, isRoot: false }
  }
  return { ok: false, reason: '路径不在允许目录内: ' + abs }
}

function truncate(s, n) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '\n…(已截断)' : s
}

function execTool(name, args) {
  const a = args || {}
  try {
    switch (name) {
      case 'list_dir': {
        const r = safeResolve(a.path)
        if (!r.ok) return { text: r.reason, isError: true }
        const entries = fs.readdirSync(r.abs, { withFileTypes: true })
        return { text: entries.map((e) => (e.isDirectory() ? '[dir] ' : '') + e.name).join('\n') }
      }
      case 'read_file': {
        const r = safeResolve(a.path)
        if (!r.ok) return { text: r.reason, isError: true }
        return { text: truncate(fs.readFileSync(r.abs, 'utf8'), 4000) }
      }
      case 'write_file': {
        const r = safeResolve(a.path)
        if (!r.ok) return { text: r.reason, isError: true }
        if (r.isRoot) return { text: '不允许把目录本身当文件写入', isError: true }
        fs.mkdirSync(path.dirname(r.abs), { recursive: true })
        fs.writeFileSync(r.abs, String(a.content ?? ''), 'utf8')
        return { text: '已写入 ' + r.abs }
      }
      case 'delete_file': {
        const r = safeResolve(a.path)
        if (!r.ok) return { text: r.reason, isError: true }
        if (r.isRoot) return { text: '不允许删除目录本身', isError: true }
        const st = fs.lstatSync(r.abs)
        if (st.isDirectory()) return { text: '只支持删除单个文件，不允许删除目录', isError: true }
        fs.unlinkSync(r.abs)
        return { text: '已删除 ' + r.abs }
      }
      case 'create_docx':
      case 'create_pdf':
      case 'create_pptx': {
        const r = safeResolve(a.path)
        if (!r.ok) return { text: r.reason, isError: true }
        if (r.isRoot) return { text: '不允许把目录本身当文件写入', isError: true }
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-build-'))
        const inJson = path.join(tmp, 'input.json')
        const payload = {
          kind: name.replace('create_', ''),
          out: r.abs,
          text: String(a.text ?? ''),
          slides: Math.max(1, parseInt(a.slides, 10) || 1),
          slides_text: Array.isArray(a.slides_text) ? a.slides_text.map(String) : undefined,
        }
        fs.writeFileSync(inJson, JSON.stringify(payload), 'utf8')
        try {
          const res = spawnSync('python', [path.join(SCRIPT_DIR, '_qwen_build.py'), inJson], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
          if (res.status !== 0) return { text: '构建失败：' + String(res.stderr || res.stdout || '未知错误').slice(0, 500), isError: true }
          return { text: '已创建 ' + r.abs }
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true })
        }
      }
      default:
        return { text: '未知工具: ' + name, isError: true }
    }
  } catch (err) {
    return { text: '工具执行失败：' + (err && err.message || err), isError: true }
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return
  const { id, method, params } = msg
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'qwen-files', version: '1.0.0' },
        },
      })
    } else if (method === 'notifications/initialized') {
      // 无需回复
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    } else if (method === 'tools/call') {
      const r = execTool(params && params.name, (params && params.arguments) || {})
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], isError: !!r.isError } })
    } else if (method === 'shutdown') {
      send({ jsonrpc: '2.0', id, result: null })
      process.exit(0)
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err && err.message || err) } })
  }
}

process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    try { handle(JSON.parse(line)) } catch { /* 忽略坏消息 */ }
  }
})
process.stdin.on('end', () => process.exit(0))
