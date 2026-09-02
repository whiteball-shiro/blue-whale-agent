// 轻量 MCP(stdio) 客户端：JSON-RPC 2.0 over stdio，供主进程使用（无外部依赖，便于 asar 打包）
'use strict'
const { spawn } = require('child_process')
const readline = require('readline')

class McpClient {
  constructor(def) {
    this.def = def                    // {id, name, command, args, env}
    this.proc = null
    this.rl = null
    this.nextId = 1
    this.pending = new Map()
    this.ready = false
    this.tools = []
  }

  async connect() {
    if (this.proc) return
    // Windows 下只有裸命令（如 npx，实际是 npx.cmd）才需要 shell 解析 PATH；
    // 带完整路径的程序（D:\node js\node.exe 等）若也走 shell，路径/参数里的空格会被 cmd 拆坏，导致 MCP 服务秒退
    const useShell = process.platform === 'win32' && !/[\\/]/.test(String(this.def.command || ''))
    this.proc = spawn(this.def.command, this.def.args || [], {
      env: { ...process.env, ...(this.def.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
    })
    this.proc.on('error', (err) => { this.ready = false; this.proc = null; this.rejectAll('MCP 启动失败：' + err.message) })
    this.rl = readline.createInterface({ input: this.proc.stdout })
    this.rl.on('line', (line) => { try { this._onLine(line) } catch (e) { /* ignore */ } })
    this.proc.on('exit', () => { this.ready = false; this.proc = null; this.rejectAll('mcp server exited') })
    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'whale-pet', version: '1.0' },
    }, 15000)
    this._notify('notifications/initialized', {})
    this.ready = true
  }

  _onLine(line) {
    const t = line.trim()
    if (!t) return
    let msg
    try { msg = JSON.parse(t) } catch (e) { return }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error('MCP: ' + (msg.error.message || 'error')))
      else p.resolve(msg.result)
    }
  }

  rejectAll(reason) {
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }

  _request(method, params, timeout) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') }
      catch (err) { this.pending.delete(id); reject(err); return }
      if (timeout) setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('MCP request timeout: ' + method)) }
      }, timeout)
    })
  }

  _notify(method, params) {
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') } catch (e) { /* ignore */ }
  }

  async listTools() {
    const r = await this._request('tools/list', {}, 15000)
    this.tools = (r && r.tools || []).map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }))
    return this.tools
  }

  async call(name, args) {
    const r = await this._request('tools/call', { name, arguments: args || {} }, 120000)
    const text = (r && r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    return { text: String(text || '(无输出)').slice(0, 4000), isError: !!(r && r.isError) }
  }

  close() {
    try {
      if (this.proc && this.proc.pid) {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true })
        else this.proc.kill()
      }
    } catch (e) { /* ignore */ }
  }
}

// 缓存已连接的 server，按 serverId 索引
const clients = new Map()
function getClient(def) {
  let c = clients.get(def.id)
  if (!c) { c = new McpClient(def); clients.set(def.id, c) }
  return c
}
function closeAll() { for (const c of clients.values()) c.close(); clients.clear() }

// 工具名标识：客户端不接受冒号，用 serverId_toolName，并保留映射回 server+tool
function toolKey(serverId, toolName) {
  return decodeURIComponent(serverId).replace(/[^a-zA-Z0-9_-]/g, '_') + '_' +
    decodeURIComponent(toolName).replace(/[^a-zA-Z0-9_-]/g, '_')
}

module.exports = { McpClient, getClient, closeAll, toolKey }
