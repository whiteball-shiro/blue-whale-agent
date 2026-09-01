// DeepSeek 余额桌宠 —— 渲染层
// 拖拽(屏幕坐标)、四分之一吸附(可关)、镜像、Q弹、缩放、点击刷新、右键菜单、自定义名称。
// 新增：悬停详情、闲置半透明、情绪表情、变动弹跳、提示音效、随机语录、自定义图片、今日消耗。
'use strict'

var MIN_SCALE = 0.6
var MAX_SCALE = 1.4
var STEP = 0.1
var CLICK_SQ = 9
var ANIM_MS = 700
var CHANGE_MS = 900
var QUOTE_SHOW_MS = 4000
var QUOTE_INTERVAL_MS = 30000

var root = document.getElementById('root')
var body = document.getElementById('body')
var img = document.getElementById('img')
var labelEl = document.getElementById('labelEl')
var amountEl = document.getElementById('amountEl')
var hintEl = document.getElementById('hintEl')
var timeEl = document.getElementById('timeEl')
var textBox = document.getElementById('textBox')
var moodEl = document.getElementById('moodEl')
var minusBtn = document.getElementById('minusBtn')
var plusBtn = document.getElementById('plusBtn')
var menu = document.getElementById('menu')
var menuStats = document.getElementById('menuStats')

var state = {
  scale: 1,
  h: 'right',
  hOff: 0,
  v: 'bottom',
  vOff: 0,
  left: 0,
  top: 0,
  size: 196,
  snap: true,
  label: 'DeepSeek 余额',
  refreshSec: 30,
  balance: null,
  currency: null,
  granted: null,
  toppedUp: null,
  cachedAt: null,
  status: 'loading',
  message: '',
  mood: '',
  lowThreshold: 5,
  flags: {
    showTime: true,
    idleTransparency: true, idleSec: 5,
    mood: true, bounceAnim: true, sound: true,
    quotesEnabled: false, quotesText: '',
    customImage: false,
  },
  quotes: [],
}
var busy = false
var settleTimer = null
var drag = null
var dragFrame = null
var animId = null
var quoteTimer = null
var idleTimer = null
var lastActivity = Date.now()
var idleOn = false
var screen = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }

function fmt(balance, currency) {
  var num = Number(balance)
  var fixed = isFinite(num) ? num.toFixed(2) : '--'
  return currency === 'CNY' ? '¥ ' + fixed : fixed + (currency ? ' ' + currency : '')
}

function applyLabel(text) {
  state.label = text || 'DeepSeek 余额'
  labelEl.textContent = state.label
  var len = state.label.length
  var size = len <= 8 ? 68 : Math.max(34, Math.round(68 * 8 / len))
  labelEl.style.fontSize = 'calc(var(--dshp-u) * ' + size + ')'
}

function applyFlags(c) {
  if (!c) return
  var f = state.flags
  if (typeof c.showTime === 'boolean') { f.showTime = c.showTime; applyTime() }
  if (typeof c.idleTransparency === 'boolean') f.idleTransparency = c.idleTransparency
  if (typeof c.idleSec === 'number') f.idleSec = c.idleSec
  if (typeof c.mood === 'boolean') f.mood = c.mood
  if (typeof c.bounceAnim === 'boolean') f.bounceAnim = c.bounceAnim
  if (typeof c.sound === 'boolean') f.sound = c.sound
  if (typeof c.quotesEnabled === 'boolean') f.quotesEnabled = c.quotesEnabled
  if (typeof c.quotesText === 'string') {
    f.quotesText = c.quotesText
    state.quotes = c.quotesText.split(/[;；\n]+/).map(function (s) { return s.trim() }).filter(function (s) { return s.length > 0 })
  }
  if (typeof c.lowThreshold === 'number') state.lowThreshold = c.lowThreshold
  if (typeof c.customImage === 'boolean') f.customImage = c.customImage
}

var timeShown = ''
function applyTime() {
  timeEl.style.display = state.flags.showTime ? 'block' : 'none'
  updateTime()
}
function updateTime() {
  var d = new Date()
  var p = function (n) { return String(n).padStart(2, '0') }
  var txt = p(d.getHours()) + ':' + p(d.getMinutes())
  if (txt !== timeShown) { timeShown = txt; timeEl.textContent = txt }
}

function applyImage() {
  if (!state.flags.customImage) {
    img.src = '../assets/DSniang02.png'
    return
  }
  window.pet.getImageUrl().then(function (r) {
    if (r && r.url) img.src = r.url
    else img.src = '../assets/DSniang02.png'
  })
}

// ---------------------------------------------------------------------------
// 音效（Web Audio 合成，无需音频文件）
// ---------------------------------------------------------------------------
var audioCtx = null
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function () {})
    }
    return audioCtx
  } catch (err) { return null }
}
function beep(kind) {
  if (!state.flags.sound) return
  var ctx = ensureAudio()
  if (!ctx) return
  try {
    var t = ctx.currentTime
    var notes = kind === 'up' ? [880, 1318.5] : (kind === 'down' ? [523.25, 392] : [392, 392])
    notes.forEach(function (freq, idx) {
      var osc = ctx.createOscillator()
      var gain = ctx.createGain()
      osc.type = 'sine'
      var start = t + idx * 0.12
      osc.frequency.setValueAtTime(freq, start)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.3)
    })
  } catch (err) { /* ignore */ }
}
// 首次用户点击时解锁音频（兼容自动播放策略）
function unlockAudio() {
  var ctx = ensureAudio()
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {})
}
root.addEventListener('pointerdown', unlockAudio)

// ---------------------------------------------------------------------------
// 情绪 + 弹跳
// ---------------------------------------------------------------------------
function setMood(kind) {
  if (!state.flags.mood) { moodEl.textContent = ''; moodEl.style.display = 'none'; return }
  var map = { up: '😊', down: '😢', low: '😰' }
  state.mood = kind
  moodEl.textContent = map[kind] || ''
  moodEl.style.display = map[kind] ? 'block' : 'none'
}

function bounce() {
  if (!state.flags.bounceAnim) return
  body.classList.remove('dshp-bounce')
  void body.offsetWidth  // 强制重绘以重启动画
  body.classList.add('dshp-bounce')
}

// ---------------------------------------------------------------------------
// 随机语录
// ---------------------------------------------------------------------------
function scheduleQuote() {
  if (quoteTimer) clearTimeout(quoteTimer)
  quoteTimer = null
  if (!state.flags.quotesEnabled || state.quotes.length === 0) return
  quoteTimer = setTimeout(function () {
    quoteTimer = null
    var q = state.quotes[Math.floor(Math.random() * state.quotes.length)]
    var saved = hintEl.textContent
    hintEl.textContent = q
    setTimeout(function () {
      if (hintEl.textContent === q) render()
    }, QUOTE_SHOW_MS)
    scheduleQuote()
  }, QUOTE_INTERVAL_MS)
}

// ---------------------------------------------------------------------------
// 闲置半透明
// ---------------------------------------------------------------------------
function markActivity() {
  lastActivity = Date.now()
  if (idleOn) {
    idleOn = false
    window.pet.setIdle(false)
  }
}
function checkIdle() {
  if (!state.flags.idleTransparency) return
  if (!idleOn && Date.now() - lastActivity > state.flags.idleSec * 1000) {
    idleOn = true
    window.pet.setIdle(true)
  }
}

// 测试钩子：返回音频上下文状态（自检用）
window.__dshpAudioTest = function () {
  var ctx = ensureAudio()
  return ctx ? ctx.state : 'none'
}

// ---------------------------------------------------------------------------
// 余额
// ---------------------------------------------------------------------------
function refresh(manual) {
  if (busy) return
  busy = true
  // 自动/手动刷新都保留旧数字，新值到达后直接从旧值滚动动画；
  // 只有首次加载（还没有任何余额）才显示加载态
  if (state.balance === null) { state.status = 'loading'; render() }
  var fb = window.__dshpFakeBalance
  var balancePromise = (fb !== null && fb !== undefined)
    ? Promise.resolve(typeof fb === 'function' ? fb() : fb)
    : window.pet.getBalance()
  balancePromise
    .then(function (data) {
      if (data && data.ok) {
        var nb = Number(data.totalBalance)
        var nc = String(data.currency || 'CNY')
        var prevBalance = state.balance
        var changed = state.balance !== null && (nb !== state.balance || nc !== state.currency)
        var currencyChanged = state.currency !== null && nc !== state.currency
        state.balance = nb
        state.currency = nc
        state.granted = data.grantedBalance
        state.toppedUp = data.toppedUpBalance
        state.cachedAt = data.cachedAt
        state.message = data.stale ? '网络抖动，沿用上次余额' : ''
        var low = state.lowThreshold > 0 && nb < state.lowThreshold
        if (low) {
          setMood('low')
          if (changed) beep('low')
          amountEl.classList.add('dshp-low')
        } else {
          amountEl.classList.remove('dshp-low')
          if (changed) {
            if (nb > prevBalance) setMood('up')
            else setMood('down')
            beep(nb > prevBalance ? 'up' : 'down')
          } else if (state.mood === 'up' || state.mood === 'down') {
            setMood('')
          }
        }
        if (changed && !currencyChanged) {
          state.status = 'changing'
          animateAmount(shownAmount(), nb, nc, ANIM_MS)
          if (settleTimer) clearTimeout(settleTimer)
          settleTimer = setTimeout(function () {
            settleTimer = null
            if (state.status === 'changing') { state.status = 'ok'; render() }
          }, CHANGE_MS)
          bounce()
        } else {
          if (animId === null) amountEl.textContent = fmt(nb, nc)
          state.status = 'ok'
          render()
        }
      } else {
        state.status = 'error'
        state.message = (data && data.error) ? String(data.error) : '获取失败'
        render()
        setMood('')
      }
    })
    .catch(function () {
      state.status = 'error'
      state.message = '获取失败'
      render()
    })
    .finally(function () { busy = false })
}

function shownAmount() {
  var txt = amountEl.textContent.replace(/[^\d.\-]/g, '')
  var n = parseFloat(txt)
  return isFinite(n) ? n : state.balance
}

function animateAmount(from, to, currency, duration) {
  if (animId) cancelAnimationFrame(animId)
  if (from === null || !isFinite(from)) { amountEl.textContent = fmt(to, currency); return }
  var t0 = performance.now()
  function frame(t) {
    var p = clamp((t - t0) / duration, 0, 1)
    var e = 1 - Math.pow(1 - p, 3)
    var cur = from + (to - from) * e
    amountEl.textContent = fmt(cur, currency)
    if (p < 1) animId = requestAnimationFrame(frame)
    else animId = null
  }
  animId = requestAnimationFrame(frame)
}

function render() {
  if (state.status === 'changing') return
  if (state.status === 'ok') {
    amountEl.textContent = fmt(state.balance, state.currency)
    hintEl.textContent = state.message || '点击刷新'
  } else if (state.status === 'loading') {
    amountEl.textContent = '--'
    hintEl.textContent = '加载中…'
  } else {
    amountEl.textContent = state.balance !== null ? fmt(state.balance, state.currency) : '--'
    hintEl.textContent = state.message || '获取失败'
  }
}

// ---------------------------------------------------------------------------
// 缩放
// ---------------------------------------------------------------------------
function adjust(delta) {
  var next = Math.round(clamp(state.scale + delta, MIN_SCALE, MAX_SCALE) * 10) / 10
  if (next === state.scale) return
  state.scale = next
  window.pet.setScale(next).then(function (r) {
    if (r && typeof r.size === 'number') state.size = r.size
    settle()
  })
}

minusBtn.addEventListener('pointerdown', function (e) { e.stopPropagation() })
plusBtn.addEventListener('pointerdown', function (e) { e.stopPropagation() })
minusBtn.addEventListener('click', function (e) { e.stopPropagation(); adjust(-STEP) })
plusBtn.addEventListener('click', function (e) { e.stopPropagation(); adjust(STEP) })

// ---------------------------------------------------------------------------
// 拖拽 + Q弹
// ---------------------------------------------------------------------------
var dragFrameId = null
function scheduleExpress() {
  if (dragFrameId) return
  dragFrameId = requestAnimationFrame(function () {
    dragFrameId = null
    express()
  })
}

function onPointerDown(e) {
  if (e.button !== 0) return
  try { root.setPointerCapture(e.pointerId) } catch (err) {}
  var rect = root.getBoundingClientRect()
  drag = {
    active: true,
    ready: false,
    startScreenX: e.screenX,
    startScreenY: e.screenY,
    grabX: 0,
    grabY: 0,
    w: rect.width,
    h: rect.height,
    moved: false,
    vp: screen.workArea
  }
  root.classList.add('dshp-dragging')
  pressDown()
  window.pet.getPosition().then(function (pos) {
    if (!drag || !drag.active) return
    drag.grabX = drag.startScreenX - pos.x
    drag.grabY = drag.startScreenY - pos.y
    drag.ready = true
  })
}

function onPointerMove(e) {
  if (!drag || !drag.active || !drag.ready) return
  var mx = e.screenX - drag.startScreenX
  var my = e.screenY - drag.startScreenY
  if (mx * mx + my * my >= CLICK_SQ) drag.moved = true
  var wa = drag.vp
  state.left = clamp(e.screenX - drag.grabX, wa.x, Math.max(wa.x, wa.x + wa.width - drag.w))
  state.top = clamp(e.screenY - drag.grabY, wa.y, Math.max(wa.y, wa.y + wa.height - drag.h))
  scheduleExpress()
}

function endDrag(e, clickAllowed) {
  if (!drag || !drag.active) return
  drag.active = false
  pressUp()
  root.classList.remove('dshp-dragging')
  try {
    if (root.hasPointerCapture && root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId)
  } catch (err) {}
  if (clickAllowed && !drag.moved) { refresh(true); return }
  if (dragFrameId) { cancelAnimationFrame(dragFrameId); dragFrameId = null }
  var wa = drag.vp
  var left = clamp(e.screenX - drag.grabX, wa.x, Math.max(wa.x, wa.x + wa.width - drag.w))
  var top = clamp(e.screenY - drag.grabY, wa.y, Math.max(wa.y, wa.y + wa.height - drag.h))
  if (state.snap) {
    var centerX = left + drag.w / 2
    var centerY = top + drag.h / 2
    if (centerX < wa.x + wa.width / 4) { state.h = 'left'; state.hOff = 0 }
    else if (centerX > wa.x + wa.width * 3 / 4) { state.h = 'right'; state.hOff = 0 }
    else { state.h = null; state.hOff = left }
    if (centerY < wa.y + wa.height / 4) { state.v = 'top'; state.vOff = 0 }
    else if (centerY > wa.y + wa.height * 3 / 4) { state.v = 'bottom'; state.vOff = 0 }
    else { state.v = null; state.vOff = top }
  } else {
    state.h = null
    state.v = null
    state.hOff = left
    state.vOff = top
  }
  state.left = left
  state.top = top
  settle()
}

// 抓取时只做轻微等比缩放，避免非等比压扁导致拖动时鲸鱼看起来在变形/放大
var SQUISH = 'scale(0.96)'
function pressDown() { body.style.transform = SQUISH }
function pressUp() { body.style.transform = 'scale(1)' }

root.addEventListener('pointerdown', onPointerDown)
root.addEventListener('pointermove', onPointerMove)
root.addEventListener('pointerup', function (e) { endDrag(e, true) })
root.addEventListener('pointercancel', function (e) { endDrag(e, false) })
window.addEventListener('resize', function () {
  window.pet.getSize().then(function (r) {
    if (r && typeof r.size === 'number') state.size = r.size
    settle()
  })
})

// ---------------------------------------------------------------------------
// 位置/吸附
// ---------------------------------------------------------------------------
function express() {
  return window.pet.setPosition(state.left, state.top)
}

function settle() {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(function () {
    settleTimer = null
    var wa = screen.workArea
    var s = state.size
    var left, top
    if (state.snap) {
      left = state.h === 'left' ? wa.x : (state.h === 'right' ? wa.x + wa.width - s : state.left)
      top = state.v === 'top' ? wa.y : (state.v === 'bottom' ? wa.y + wa.height - s : state.top)
      left = state.h === null ? clamp(left, wa.x, Math.max(wa.x, wa.x + wa.width - s)) : left
      top = state.v === null ? clamp(top, wa.y, Math.max(wa.y, wa.y + wa.height - s)) : top
    } else {
      left = clamp(state.left, wa.x, Math.max(wa.x, wa.x + wa.width - s))
      top = clamp(state.top, wa.y, Math.max(wa.y, wa.y + wa.height - s))
    }
    state.left = left
    state.top = top
    updateMirror()
    express()
  }, 0)
}

function updateMirror() {
  if (state.snap && state.h === 'left') root.classList.add('dshp-left')
  else root.classList.remove('dshp-left')
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------
function hideMenu() { menu.classList.remove('dshp-open') }
window.addEventListener('contextmenu', function (e) {
  e.preventDefault()
  // 先临时显示以测得真实尺寸，避免 display:none 时 offset 为 0 导致菜单底部被裁掉
  menu.style.visibility = 'hidden'
  menu.classList.add('dshp-open')
  var mw = menu.offsetWidth || 150
  var mh = menu.offsetHeight || 150
  var x = Math.min(e.clientX, window.innerWidth - mw)
  var y = Math.min(e.clientY, window.innerHeight - mh)
  menu.style.left = Math.max(0, x) + 'px'
  menu.style.top = Math.max(0, y) + 'px'
  menu.style.visibility = 'visible'
})
window.addEventListener('pointerdown', function (e) {
  if (!menu.contains(e.target)) hideMenu()
})
menu.addEventListener('click', function (e) {
  var act = e.target.getAttribute && e.target.getAttribute('data-act')
  if (!act) return
  hideMenu()
  if (act === 'refresh') refresh(true)
  else if (act === 'chat') window.pet.openChat()
  else if (act === 'settings') window.pet.openSettings()
  else if (act === 'quit') window.pet.quit()
})

// 对话时隐藏余额（美观），关闭对话后恢复
window.pet.onChatClose(function () { if (textBox) textBox.style.display = '' })

function refreshStats() {
  window.pet.getStats().then(function (st) {
    if (st) {
      menuStats.textContent = '今日消耗：' + (st.currency === 'CNY' ? '¥ ' : '') + Number(st.todayUsed).toFixed(2)
    }
  })
}

// ---------------------------------------------------------------------------
// 悬停详情 + 闲置
// ---------------------------------------------------------------------------
root.addEventListener('pointermove', markActivity)
root.addEventListener('pointerdown', markActivity)
setInterval(checkIdle, 1000)

// ---------------------------------------------------------------------------
// 配置更新
// ---------------------------------------------------------------------------
window.pet.onConfigUpdated(function () {
  window.pet.getConfig().then(function (c) {
    if (!c) return
    if (typeof c.snap === 'boolean') state.snap = c.snap
    if (typeof c.label === 'string') applyLabel(c.label)
    if (typeof c.refreshSec === 'number') {
      state.refreshSec = c.refreshSec
      startAutoRefresh()
    }
    applyFlags(c)
    applyImage()
    scheduleQuote()
    settle()
    refreshStats()
  })
})

// ---------------------------------------------------------------------------
// 定时刷新
// ---------------------------------------------------------------------------
var refreshTimer = null
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
  var sec = state.refreshSec
  if (sec > 0) {
    refreshTimer = setInterval(function () { refresh(false) }, sec * 1000)
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
Promise.all([window.pet.getPosition(), window.pet.getScreen(), window.pet.getSize(), window.pet.getConfig()])
  .then(function (res) {
    state.left = res[0].x
    state.top = res[0].y
    screen = res[1]
    state.size = res[2].size
    state.scale = res[2].scale
    if (res[3]) {
      if (typeof res[3].scale === 'number') state.scale = res[3].scale
      if (typeof res[3].snap === 'boolean') state.snap = res[3].snap
      if (typeof res[3].label === 'string') applyLabel(res[3].label)
      if (typeof res[3].refreshSec === 'number') state.refreshSec = res[3].refreshSec
      applyFlags(res[3])
    } else {
      applyLabel('DeepSeek 余额')
    }
    applyImage()
    applyTime()
    startAutoRefresh()
    scheduleQuote()
    refreshStats()
    settle()
    refresh(false)
    setInterval(updateTime, 1000)
  })
  .catch(function () {
    applyLabel('DeepSeek 余额')
    refresh(false)
  })

window.pet.onRefreshRequested(function () { refresh(true); refreshStats() })

// 测试钩子（仅自检使用）
window.__dshpTestRefresh = function () { refresh(false) }
window.__dshpTestState = function () { return { amount: amountEl.textContent, status: state.status } }
window.__dshpSetFakeBalance = function (v) { window.__dshpFakeBalance = v }
window.__dshpFlags = function () { return JSON.parse(JSON.stringify(state.flags)) }
window.__dshpConfig = function () { return { snap: state.snap, label: state.label, refreshSec: state.refreshSec } }
