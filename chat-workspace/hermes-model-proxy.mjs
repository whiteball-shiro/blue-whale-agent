// Hermes -> AMD 网关模型名修正代理
// 用途：Hermes 会把模型名转小写/截断（如 deepseek-v4-flash-vision-exp），而 AMD 网关只认
// 原大小写全名（DeepSeek-V4-Flash-Vision-Exp）。本代理在中间把模型名改回网关能认的写法。
// 启动：node hermes-model-proxy.mjs   （监听 127.0.0.1:18999）
import http from 'node:http'
import https from 'node:https'

const PORT = Number(process.env.PORT || 18999)
const UPSTREAM = 'https://developer.amd.com.cn/radeon/api/v1'

const MODEL_MAP = {
  'deepseek-v4-flash-vision-exp': 'DeepSeek-V4-Flash-Vision-Exp',
  'deepseek-v4-flash': 'DeepSeek-V4-Flash',
  'minicpm5-1b': 'MiniCPM5-1B',
  'qwen3.8-flash-next': 'Qwen3.8-Flash-Next',
}

function fixModel(m) {
  if (typeof m !== 'string') return m
  const lower = m.trim().toLowerCase()
  if (MODEL_MAP[lower]) return MODEL_MAP[lower]
  if (lower.startsWith('deepseek-v4-flash')) {
    return lower.includes('vision') ? 'DeepSeek-V4-Flash-Vision-Exp' : 'DeepSeek-V4-Flash'
  }
  return m
}

function proxyReq(req, res, bodyBuf) {
  const headers = Object.assign({}, req.headers)
  delete headers.host
  delete headers['content-length']
  delete headers['accept-encoding']
  delete headers.connection
  if (bodyBuf) headers['content-length'] = Buffer.byteLength(bodyBuf)
  // UPSTREAM 已含 /v1，客户端路径若也带 /v1 要去重，否则会拼成 /v1/v1/...
  const rawPath = String(req.url || '/')
  const tail = rawPath.startsWith('/v1') ? rawPath.slice(3) : rawPath
  const upReq = https.request(UPSTREAM + tail, {
    method: req.method,
    headers,
  }, (upRes) => {
    const h = Object.assign({}, upRes.headers)
    delete h['transfer-encoding']
    delete h['content-length']
    delete h.connection
    res.writeHead(upRes.statusCode || 502, h)
    upRes.pipe(res)
  })
  upReq.on('error', (e) => {
    try { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'proxy upstream error: ' + e.message } })) } catch (_) { /* ignore */ }
  })
  if (bodyBuf) upReq.write(bodyBuf)
  upReq.end()
}

const server = http.createServer((req, res) => {
  const isChat = /\/chat\/completions$/.test(req.url || '')
  if (req.method !== 'POST' || !isChat) {
    proxyReq(req, res, null)
    return
  }
  const chunks = []
  let size = 0
  req.on('data', (c) => {
    size += c.length
    if (size > 20 * 1024 * 1024) { req.destroy(); return }
    chunks.push(c)
  })
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (body && body.model) body.model = fixModel(body.model)
      // Hermes 会发 thinking 参数，AMD 网关不认；统一转成 reasoning_effort
      if (body && 'thinking' in body) {
        const want = body.thinking && body.thinking.effort
        delete body.thinking
        if (!body.reasoning_effort && want) body.reasoning_effort = want
      }
      if (body && !body.reasoning_effort) body.reasoning_effort = 'medium'
      proxyReq(req, res, Buffer.from(JSON.stringify(body), 'utf8'))
    } catch (e) {
      try { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad json: ' + e.message } })) } catch (_) { /* ignore */ }
    }
  })
  req.on('error', () => { try { res.destroy() } catch (_) { /* ignore */ } })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('hermes model proxy listening on 127.0.0.1:' + PORT)
})
