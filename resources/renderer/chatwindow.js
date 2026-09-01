'use strict'
var titleEl = document.getElementById('titleEl') // 在重排后的顶栏中不再显示标题，作空引用处理
function setTitle(t) { if (titleEl) titleEl.textContent = t }
var msgsEl = document.getElementById('msgsEl')
var inputEl = document.getElementById('inputEl')
var sendBtn = document.getElementById('sendBtn')
var stopBtn = document.getElementById('stopBtn')
var attachBtn = document.getElementById('attachBtn')
var clipBtn = document.getElementById('clipBtn')
var historyBtn = document.getElementById('historyBtn')
var closeBtn = document.getElementById('closeBtn')
var historyEl = document.getElementById('historyEl')
var listEl = document.getElementById('listEl')
var newBtn = document.getElementById('newBtn')
var archivedToggle = document.getElementById('archivedToggle')
var backBtn = document.getElementById('backBtn')
var histCloseBtn = document.getElementById('histCloseBtn')
var modelEl = document.getElementById('modelEl')
var lookBtn = document.getElementById('lookBtn')
var visionBtn = document.getElementById('visionBtn')
var thinkBtn = document.getElementById('thinkBtn')
var screenPreview = document.getElementById('screenPreview')
var ctxBadge = document.getElementById('ctxBadge')
var ctxBar = document.getElementById('ctxBar')
var mcpToggle = document.getElementById('mcpToggle')
var toolList = document.getElementById('toolList')
var mcpHint = document.getElementById('mcpHint')
var attachChip = document.getElementById('attachChip')
var provCodex = document.getElementById('provCodex')
var provLms = document.getElementById('provLms')
var provLlm = document.getElementById('provLlm')
var routeBtn = document.getElementById('routeBtn')
var gpuVramLabel = document.getElementById('gpuVramLabel')

var chats = []
var current = null
var showArchived = false
var sending = false
var lookOn = false
var visionOn = false
var thinkingOn = true
var routeOn = true
var provider = 'codex'
var streamBubble = null
var pendingAttach = null

function esc(s) {
  var d = document.createElement('div')
  d.textContent = s == null ? '' : String(s)
  return d.innerHTML
}

function addMsg(role, text) {
  var row = document.createElement('div')
  row.className = 'row ' + role
  var b = document.createElement('div')
  b.className = 'bubble'
  b.textContent = text
  row.appendChild(b)
  msgsEl.appendChild(row)
  msgsEl.scrollTop = msgsEl.scrollHeight
  return b
}

function renderMsgs() {
  msgsEl.innerHTML = ''
  if (!current || !current.messages || current.messages.length === 0) {
    addMsg('bot', '和它说说吧～点右上“历史”可新建或查看旧会话。')
    return
  }
  current.messages.forEach(function (m) { addMsg(m.role === 'user' ? 'user' : 'bot', m.content) })
}

function renderList() {
  var items = chats.filter(function (c) { return showArchived ? c.archived : !c.archived })
  if (items.length === 0) {
    listEl.innerHTML = '<div class="hempty">' + (showArchived ? '没有已归档的对话' : '还没有对话') + '</div>'
    return
  }
  listEl.innerHTML = items.map(function (c) {
    return '<div class="hitem ' + (current && current.id === c.id ? 'active' : '') + '" data-id="' + c.id + '">' +
      '<span>' + esc(c.title || '（新对话）') + '</span>' +
      '<span class="acts">' +
        '<button data-arch="' + (c.archived ? '0' : '1') + '" title="归档/恢复">' + (c.archived ? '⤴' : '🗂') + '</button>' +
        '<button data-del="1" title="删除">🗑</button>' +
      '</span></div>'
  }).join('')
  archivedToggle.textContent = showArchived ? '收起归档 ▴' : '已归档 ▾'
}

function loadList() {
  return window.pet.chat.list().then(function (r) {
    chats = (r && r.conversations) || []
    renderList()
  })
}

function renderProviderUI() {
  provCodex.classList.toggle('on', provider === 'codex')
  provLms.classList.toggle('on', provider === 'lmstudio')
  provLlm.classList.toggle('on', provider === 'llm')
}
function loadModels() {
  if (provider === 'llm') {
    window.pet.chat.getLlm().then(function (r) {
      var model = (r && r.model) || ''
      var base = (r && r.baseUrl) || ''
      var label = model ? ('LLM: ' + model) : 'LLM 接口未配置（请在 config 填 llmModel）'
      modelEl.innerHTML = '<option value="' + esc(model) + '"' + (model ? ' selected' : '') + '>' + esc(label) + '</option>'
      if (model && modelEl.value !== model) modelEl.value = model
      modelEl.title = base ? ('接口：' + base) : '未配置 LLM 接口地址'
      loadVision()
    })
    return
  }
  var getter = provider === 'lmstudio' ? window.pet.chat.lmModels() : window.pet.chat.models()
  Promise.all([getter, window.pet.chat.getModel()]).then(function (r) {
    var list = (r && r[0] && r[0].models) || []
    var cur = (r && r[1] && r[1].model) || ''
    var html
    if (provider === 'codex') {
      html = '<option value="">默认（跟随 Codex）</option>' + list.map(function (m) {
        return '<option value="' + esc(m.slug) + '"' + (m.slug === cur ? ' selected' : '') + '>' + esc(m.displayName || m.slug) + '</option>'
      }).join('')
    } else {
      html = list.map(function (m) {
        return '<option value="' + esc(m.id) + '"' + (m.id === cur ? ' selected' : '') + '>' + esc(m.displayName || m.id) + '</option>'
      }).join('')
    }
    modelEl.innerHTML = html
    modelEl.title = ''
    // 本地模式自动选中第一个模型，避免把 null 传给 LM Studio
    if (provider === 'lmstudio' && list.length && (!cur || (cur !== '' && list.every(function (m) { return m.id !== cur })))) {
      var firstId = list[0].id
      modelEl.value = firstId
      window.pet.chat.setModel(firstId)
    }
    loadVision()
  })
}
function loadProvider() {
  window.pet.chat.getProvider().then(function (r) {
    provider = (r && r.provider === 'lmstudio') ? 'lmstudio' : ((r && r.provider === 'llm') ? 'llm' : 'codex')
    renderProviderUI()
    loadModels()
  })
}
function switchProvider(to) {
  if (provider === to) return
  provider = to
  window.pet.chat.setProvider(to)
  renderProviderUI()
  loadModels()
  updateCtx()
}
provCodex.addEventListener('click', function () { switchProvider('codex') })
provLms.addEventListener('click', function () { switchProvider('lmstudio') })
provLlm.addEventListener('click', function () { switchProvider('llm') })

function loadRoute() {
  window.pet.chat.getLocalRoute().then(function (r) {
    routeOn = !!(r && r.on)
routeBtn.classList.toggle('on', routeOn)
routeBtn.title = routeOn
? '本地分流：开（Codex/云端来源下，简单/文本任务及只读调用先交给本地模型省额度）'
: '本地分流：关（所有任务都交给当前选择的来源处理）'
  })
}
routeBtn.addEventListener('click', function () {
  routeOn = !routeOn
  window.pet.chat.setLocalRoute(routeOn).then(loadRoute)
})

function updateCtx() {
  if (provider !== 'lmstudio' || !current) { ctxBadge.textContent = ''; return }
  window.pet.chat.ctxInfo(current.id).then(function (r) {
    if (!r) { ctxBadge.textContent = ''; return }
    var rem = r.remaining || 0
    var fmt = rem >= 1000 ? (rem / 1000).toFixed(1) + 'k' : String(rem)
    ctxBadge.textContent = '剩余 ' + fmt
  })
}
function setAttach(path) {
  if (!path) return
  pendingAttach = path
  var name = path.split(/[\\/]/).pop()
  attachBtn.style.background = '#d7e0f5'
  attachBtn.title = '已附带：' + name
  attachChip.innerHTML = '已附带：' + esc(name) + ' <button id="removeAttach">✕ 移除</button>'
  attachChip.classList.add('show')
}
attachBtn.addEventListener('click', function () {
  window.pet.pickFile().then(function (r) {
    if (r && r.ok && r.path) setAttach(r.path)
  })
})
clipBtn.addEventListener('click', function () {
  window.pet.chat.grabClipboard().then(function (r) {
    if (r && r.ok && r.path) setAttach(r.path)
    else if (r && r.error) addMsg('warn', '剪贴板：' + (r.error || '没有图片'))
  })
})
// 拖拽文件到对话框上传
var cardEl = document.querySelector('.card')
;['dragover', 'dragenter'].forEach(function (ev) {
  cardEl.addEventListener(ev, function (e) { e.preventDefault(); cardEl.classList.add('drop') })
})
cardEl.addEventListener('dragleave', function (e) { e.preventDefault(); cardEl.classList.remove('drop') })
cardEl.addEventListener('drop', function (e) {
  e.preventDefault()
  cardEl.classList.remove('drop')
  var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
  if (!f) return
  // 老版 Electron 用 file.path，新版用 webUtils.getPathForFile；从中挑一个真实存在的路径
  var cands = []
  if (f && f.path) cands.push(f.path)
  var via = window.pet.getPathForFile(f)
  if (via) cands.push(via)
  var usePath = cands[0] || ''
  var settle = function (p) { setAttach(p || '') }
  if (cands.length <= 1) { settle(cands[0]); return }
  // 逐个验证是否存在，取第一个真实路径
  var idx = 0
  var step = function () {
    if (idx >= cands.length) { settle(cands[0]); return }
    var c = cands[idx++]
    window.pet.fileExists(c).then(function (r) {
      if (r && r.exists) { settle(c); return }
      step()
    })
  }
  step()
})
document.addEventListener('click', function (e) {
  if (e.target && e.target.id === 'removeAttach') {
    pendingAttach = null
    attachBtn.style.background = ''
    attachBtn.title = '附带图片/文件'
    attachChip.classList.remove('show')
    attachChip.innerHTML = ''
  }
})
modelEl.addEventListener('change', function () {
  window.pet.chat.setModel(modelEl.value)
})

function loadLook() {
  window.pet.chat.getLook().then(function (r) {
    lookOn = !!(r && r.look)
    lookBtn.classList.toggle('on', lookOn)
    screenPreview.style.display = lookOn ? 'block' : 'none'
  })
}
lookBtn.addEventListener('click', function () {
  lookOn = !lookOn
  lookBtn.classList.toggle('on', lookOn)
  window.pet.chat.setLook(lookOn)
})

function loadVision() {
  window.pet.chat.getVision().then(function (r) {
    visionOn = !!(r && r.on)
    visionBtn.classList.toggle('on', visionOn)
    visionBtn.title = visionOn ? '支持看图（已开启）' : '支持看图（自动检测/已关闭）'
  })
}
visionBtn.addEventListener('click', function () {
  visionOn = !visionOn
  window.pet.chat.setVision(visionOn).then(loadVision)
})

function loadThinking() {
  window.pet.chat.getThinking().then(function (r) {
    thinkingOn = !!(r && r.on)
    thinkBtn.classList.toggle('on', thinkingOn)
    thinkBtn.textContent = thinkingOn ? '🧠 思考：开' : '🧠 思考：关'
  })
}
thinkBtn.addEventListener('click', function () {
  thinkingOn = !thinkingOn
  window.pet.chat.setThinking(thinkingOn).then(loadThinking)
})

function loadMcp() {
  window.pet.chat.getMcp().then(function (r) {
    var on = !!(r && r.on)
    mcpToggle.classList.toggle('off', !on)
    toolList.innerHTML = ''
    var servers = (r && r.servers) || []
    if (on) {
      servers.forEach(function (s) {
        var btn = document.createElement('div')
        btn.className = 'ts-tool' + (s.on ? ' on' : '')
        btn.title = s.name + (s.on ? '（已启用）' : '（已关闭）')
        btn.textContent = (s.name || 'M').slice(0, 2)
        btn.addEventListener('click', function () { window.pet.chat.setMcpServer(s.id, !s.on).then(loadMcp) })
        toolList.appendChild(btn)
      })
      mcpHint.textContent = servers.length ? '' : '扫描中…'
    } else {
      mcpHint.textContent = '点上方开启'
    }
    mcpHint.style.display = (on && servers.length) ? 'none' : ''
  })
}
mcpToggle.addEventListener('click', function () {
  window.pet.chat.getMcp().then(function (r) {
    window.pet.chat.setMcp(!(r && r.on)).then(loadMcp)
  })
})

window.pet.chat.onScreen(function (dataUrl) {
  if (!lookOn) return
  screenPreview.src = dataUrl
  screenPreview.style.display = 'block'
})

function selectChat(id) {
  window.pet.chat.get(id).then(function (r) {
    current = (r && r.conversation) || null
    setTitle(current && current.title ? current.title : '')
    renderMsgs()
    renderList()
    updateCtx()
  })
}

function send() {
  var text = inputEl.value.trim()
  if (!text || sending) return
  if (!current) {
    window.pet.chat.new().then(function (r) {
      current = (r && r.conversation) || null
      doSend(text)
    })
    return
  }
  doSend(text)
}

function doSend(text) {
  sending = true
  streamBubble = null
  stopBtn.style.display = ''
  sendBtn.style.display = 'none'
  sendBtn.disabled = true
  inputEl.value = ''
  addMsg('user', text)
  if (!current.title) current.title = text.slice(0, 40)
  setTitle(current.title)
  var typing = document.createElement('div')
  typing.className = 'typing'
  typing.textContent = '正在输入…'
  msgsEl.appendChild(typing)
  msgsEl.scrollTop = msgsEl.scrollHeight
  window.pet.chat.send(current.id, text, lookOn, pendingAttach).then(function (r) {
    if (r && r.ok === false && r.error) { typing.remove(); addMsg('error', '出错了：' + r.error); finish() }
    else if (r && r.notice) { addMsg('warn', r.notice) }
  })
  pendingAttach = null
  attachBtn.style.background = ''
  attachBtn.title = '附带图片/文件'
  attachChip.classList.remove('show')
  attachChip.innerHTML = ''
}

function finish(errText) {
  var t = document.querySelector('.typing')
  if (t) t.remove()
  streamBubble = null
  sending = false
  stopBtn.style.display = 'none'
  sendBtn.style.display = ''
  sendBtn.disabled = false
  if (errText) addMsg('error', '出错了：' + errText)
  inputEl.focus()
  loadList()
}

window.pet.chat.onDelta(function (id, text) {
  if (!current || current.id !== id) return
  var t = document.querySelector('.typing')
  if (t) t.remove()
  if (!streamBubble) {
    var row = document.createElement('div')
    row.className = 'row bot'
    var b = document.createElement('div')
    b.className = 'bubble'
    b.textContent = text
    row.appendChild(b)
    msgsEl.appendChild(row)
    streamBubble = b
  } else {
    streamBubble.textContent = text
  }
  msgsEl.scrollTop = msgsEl.scrollHeight
})

window.pet.chat.onStatus(function (id, text) {
  if (!current || current.id !== id) return
  var t = document.querySelector('.typing')
  if (!t) {
    t = document.createElement('div')
    t.className = 'typing'
    msgsEl.appendChild(t)
    msgsEl.scrollTop = msgsEl.scrollHeight
  }
  t.textContent = text
})

window.pet.chat.onDone(function (id, payload) {
  if (!current || current.id !== id) return
  var t = document.querySelector('.typing')
  if (t) t.remove()
  if (payload && payload.text) {
    if (streamBubble) streamBubble.textContent = payload.text
    if (payload.via === 'local' && streamBubble) {
      var badge = document.createElement('span')
      badge.style.cssText = 'display:block;font-size:10px;color:#8fae5a;margin-top:4px;'
      badge.textContent = '⚡ 本地模型完成'
      streamBubble.appendChild(badge)
    }
    current.messages.push({ role: 'assistant', content: payload.text })
  } else if (payload && payload.error) {
    streamBubble = null
    finish(payload.error)
    return
  }
  if (payload && payload.threadId) current.threadId = payload.threadId
  streamBubble = null
  sending = false
  stopBtn.style.display = 'none'
  sendBtn.style.display = ''
  sendBtn.disabled = false
  inputEl.focus()
  loadList()
  updateCtx()
})

sendBtn.addEventListener('click', send)
stopBtn.addEventListener('click', function () { window.pet.chat.stop() })
inputEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() }
})
closeBtn.addEventListener('click', function () { window.pet.closeChat() })
historyBtn.addEventListener('click', function () { historyEl.classList.toggle('open'); loadList() })
backBtn.addEventListener('click', function () { historyEl.classList.remove('open') })
histCloseBtn.addEventListener('click', function () { window.pet.closeChat() })
newBtn.addEventListener('click', function () {
  window.pet.chat.new().then(function (r) {
    current = (r && r.conversation) || null
    historyEl.classList.remove('open')
    setTitle('')
    renderMsgs()
    renderList()
  })
})
archivedToggle.addEventListener('click', function () { showArchived = !showArchived; renderList() })
listEl.addEventListener('click', function (e) {
  var arch = e.target.getAttribute && e.target.getAttribute('data-arch')
  var del = e.target.getAttribute && e.target.getAttribute('data-del')
  var item = e.target.closest ? e.target.closest('.hitem') : null
  if (!item) return
  var id = item.getAttribute('data-id')
  if (del) {
    if (!confirm('删除这个对话？')) return
    window.pet.chat.del(id).then(function () {
      if (current && current.id === id) { current = null; setTitle(''); renderMsgs() }
      loadList()
    })
    return
  }
  if (arch) { window.pet.chat.archive(id, arch === '1').then(loadList); return }
  historyEl.classList.remove('open')
  selectChat(id)
})

function refreshGpuStatus() {
  if (!window.pet.chat.getGpuStatus) return
  window.pet.chat.getGpuStatus().then(function (s) {
    if (!s) return
    gpuVramLabel.textContent = '显存：' + (s.vram ? Math.round(s.vram.used / 1024) + '/' + Math.round(s.vram.total / 1024) + ' GB' : 'n/a')
  }).catch(function () {})
}

refreshGpuStatus()
setInterval(refreshGpuStatus, 4000)
loadList()
loadProvider()
loadRoute()
loadLook()
loadVision()
loadThinking()
loadMcp()
