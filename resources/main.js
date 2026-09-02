// DeepSeek 余额桌宠 —— 主进程
// 透明置顶桌宠窗口、余额代理、配置/位置/尺寸持久化、设置窗口、单实例。
// 功能：低余额提醒、开机自启、消耗统计、闲置半透明、托盘、全局热键、自定义图片等。
'use strict'

const { app, BrowserWindow, ipcMain, screen, nativeImage, Tray, Menu, Notification, dialog, globalShortcut, desktopCapturer, clipboard } = require('electron')
const mcp = require('./mcp')
const readfile = require('./readfile')

// 允许 Web Audio 无需用户手势即可播放（余额刷新是后台动作）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn, execFileSync, execFile } = require('node:child_process')
const crypto = require('node:crypto')
const net = require('node:net')

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const DEFAULT_SIZE = 196
const MIN_SIZE = 96
const MAX_SIZE = 292
const MIN_SCALE = 0.6
const MAX_SCALE = 1.4

// ---------------------------------------------------------------------------
// 配置（AppData/deepseek-whale-pet/config.json）
// ---------------------------------------------------------------------------
const configPath = () => path.join(app.getPath('userData'), 'config.json')
const historyPath = () => path.join(app.getPath('userData'), 'history.json')
const customImagePath = () => path.join(app.getPath('userData'), 'custom-whale.png')

function defaultConfig() {
  return {
    apiKey: '',
    balanceUrl: '',
    snap: true,
    label: '大肥鱼',
    refreshSec: 30,
    scale: 1,
    x: null,
    y: null,
    lowBalanceAlert: true,
    lowThreshold: 5,
    autoStart: false,
    idleTransparency: true,
    idleSec: 5,
    trackStats: true,
    mood: true,
    bounceAnim: true,
    sound: true,
    quotesEnabled: false,
    quotesText: '',
    customImage: false,
    hotkey: true,
    trayIcon: true,
    showTime: true,
    displayMode: 'all',   // all | taskbar | tray | hidden
    alwaysOnTop: true,      // 是否始终置顶
    clickThrough: false,      // 鼠标穿透：点击穿透到后面的窗口
    clickThroughOpacity: 0.6, // 穿透时小鲸鱼的透明度（0.2~1）
    chatCodexPath: '',        // codex 可执行文件路径，留空自动探测
    chatDir: '',              // 对话工作目录，留空用 userData/chat-workspace
    chatModel: '',            // 对话使用的模型，留空则跟随 Codex 默认
    llmBaseUrl: '',           // 通用 OpenAI 兼容接口地址（如 https://api.openai.com/v1，留空则不启用“LLM”来源）
    localBaseUrl: '',         // 本地模型（来源“本地”）的 OpenAI 兼容地址，如 LM Studio http://127.0.0.1:1234/v1、Ollama http://127.0.0.1:11434/v1；留空回退到 LM Studio 默认端口
    llmApiKey: '',            // 通用 LLM 接口的 API Key
    llmModel: '',             // 通用 LLM 的模型名
    localModelDir: '',        // 本地模型目录（用于读取 gguf 上下文上限），留空则从 localModelPath 推导
    lookScreen: false,        // 是否在对话时附上屏幕截图（让 Codex 能讨论屏幕内画面）
    chatProvider: 'codex',    // 对话来源：codex（官方 Codex/云端） | lmstudio（本地 LM Studio） | llm（任意 OpenAI 兼容 API）
    chatForceVision: null,    // 是否强制把图片/截图作为多模态内容发送给所选模型；null=自动检测
    chatHotkey: 'Alt+Q', // 打开对话气泡的全局快捷键（Electron accelerator 格式）
    chatThinking: true,       // 本地模型是否开启“思考模式”（开=先推理再回答，慢但更好；关=直接回答更快）
    chatLocalRoute: false,    // Codex 模式下本地分流：进阶功能，默认关，需要本地模型时才打开（免得没本地模型的人一装就当机）
    chatMcp: false,          // 本地模型 MCP 工具调用：进阶功能，默认关
    mcps: [],
    mcpServersOn: {},         // 服务器开关：key = serverId，默认开启（未列出即开）
  }
}

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    return { ...defaultConfig(), ...c }
  } catch {
    return defaultConfig()
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch }
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('[whale-pet] save config failed:', err)
  }
  return next
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const petSize = (scale) => Math.round(clamp(DEFAULT_SIZE * scale, MIN_SIZE, MAX_SIZE))

let petWin = null
let settingsWin = null
let chatWin = null
let tray = null
let activeAbort = null    // 当前本地模型请求的可中止控制器（停止）
let activeChild = null    // 当前 Codex 子进程（停止）
let stopRequested = false // 用户点了“停止”
let chatOn = false
let balanceCache = null
let balanceInFlight = null
let posSaveTimer = null
let balanceFetchCount = 0
let stats = { today: '', todayUsed: 0, lastBalance: null }
let lastLowAlertAt = 0
let cfg = loadConfig()
let petIdle = false

// ---------------------------------------------------------------------------
// 消耗统计（按自然日累计，持久化到 history.json）
// ---------------------------------------------------------------------------
function todayKey() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function loadStats() {
  try {
    const h = JSON.parse(fs.readFileSync(historyPath(), 'utf8'))
    const today = todayKey()
    if (h.today === today) {
      stats = { today, todayUsed: h.todayUsed || 0, lastBalance: typeof h.lastBalance === 'number' ? h.lastBalance : null }
    } else {
      stats = { today, todayUsed: 0, lastBalance: typeof h.lastBalance === 'number' ? h.lastBalance : null }
    }
  } catch {
    stats = { today: todayKey(), todayUsed: 0, lastBalance: null }
  }
  return stats
}

function saveStats() {
  try {
    fs.mkdirSync(path.dirname(historyPath()), { recursive: true })
    fs.writeFileSync(historyPath(), JSON.stringify(stats), 'utf8')
  } catch (err) { /* ignore */ }
}

function recordBalance(nb) {
  if (typeof nb !== 'number' || !isFinite(nb)) return
  if (stats.lastBalance !== null && nb < stats.lastBalance) {
    stats.todayUsed = Math.round((stats.todayUsed + (stats.lastBalance - nb)) * 100) / 100
  }
  stats.lastBalance = nb
  saveStats()
}

// ---------------------------------------------------------------------------
// 低余额提醒
// ---------------------------------------------------------------------------
function notifyLowBalance(total, currency) {
  const now = Date.now()
  // 至少 10 分钟内不重复提醒
  if (now - lastLowAlertAt < 10 * 60 * 1000) return
  lastLowAlertAt = now
  const sym = currency === 'CNY' ? '¥' : (currency || '')
  const n = new Notification({
    title: '🐋 大肥鱼余额不足提醒',
    body: '当前余额：' + sym + ' ' + Number(total).toFixed(2) + ' ' + (currency || '') + '\n记得及时充值，避免任务中断～',
  })
  n.show()
}

// ---------------------------------------------------------------------------
// 桌宠窗口
// ---------------------------------------------------------------------------
function createPetWindow(posOverride) {
  const size = petSize(cfg.scale)
  const wa = screen.getPrimaryDisplay().workArea
  const mode = cfg.displayMode || 'all'
  // 任务栏图标只在 all / taskbar 模式显示（运行时 setSkipTaskbar 在 Windows 上不可靠，
  // 必须在创建窗口时用 skipTaskbar 参数决定）
  const skipTaskbar = (mode === 'tray' || mode === 'hidden')

  let x = cfg.x
  let y = cfg.y
  if (posOverride && typeof posOverride.x === 'number' && typeof posOverride.y === 'number') {
    x = posOverride.x
    y = posOverride.y
  }
  if (typeof x !== 'number' || typeof y !== 'number' ||
      x < wa.x - size || x > wa.x + wa.width - 1 ||
      y < wa.y - size || y > wa.y + wa.height - 1) {
    x = wa.x + wa.width - size
    y = wa.y + wa.height - size
  }

  petWin = new BrowserWindow({
    width: size,
    height: size,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  petWin.setAlwaysOnTop(true, 'screen-saver')
  applyClickThrough()
  petWin.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  petWin.once('ready-to-show', () => {
    petWin.show()
    petWin.focus()
  })
  petWin.on('closed', () => { petWin = null })
}

// 运行时 setSkipTaskbar 在 Windows 上不可靠，切换任务栏显隐需重建窗口
function recreatePetWindow() {
  const pos = petWin && !petWin.isDestroyed() ? petWin.getPosition() : null
  if (petWin && !petWin.isDestroyed()) petWin.destroy()
  petWin = null
  createPetWindow(pos ? { x: pos[0], y: pos[1] } : null)
  applyDisplayMode(cfg.displayMode)
}

// ---------------------------------------------------------------------------
// 鼠标穿透 + 穿透半透明
// ---------------------------------------------------------------------------
function applyPetOpacity() {
  if (!petWin || petWin.isDestroyed()) return
  if (chatOn) { petWin.setOpacity(1); return }
  const c = loadConfig()
  let op
  if (c.clickThrough) {
    const raw = Number(c.clickThroughOpacity)
    op = (typeof raw === 'number' && isFinite(raw)) ? clamp(raw, 0.2, 1) : 0.6
  } else if (c.idleTransparency !== false && petIdle) {
    op = 0.4
  } else {
    op = 1
  }
  petWin.setOpacity(op)
}

function applyClickThrough() {
  if (!petWin || petWin.isDestroyed()) return
  const c = loadConfig()
  const enabled = c.clickThrough === true
  petWin.setIgnoreMouseEvents(enabled, { forward: true })
  applyPetOpacity()
}

function toggleClickThrough() {
  const cur = loadConfig().clickThrough === true
  cfg = saveConfig({ clickThrough: !cur })
  applyClickThrough()
  refreshTrayMenu()
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:config-updated')
  return { clickThrough: !cur }
}

function schedulePosSave() {
  if (posSaveTimer) clearTimeout(posSaveTimer)
  posSaveTimer = setTimeout(() => {
    posSaveTimer = null
    if (!petWin || petWin.isDestroyed()) return
    const [x, y] = petWin.getPosition()
    cfg = saveConfig({ x, y })
  }, 500)
}

// ---------------------------------------------------------------------------
// 余额拉取（主进程代理，key 不出主进程）
// ---------------------------------------------------------------------------
async function fetchBalance() {
  balanceFetchCount++
  if (balanceInFlight) return balanceInFlight
  balanceInFlight = (async () => {
    const cfgNow = loadConfig()
    const key = cfgNow.apiKey.trim()
    const url = (cfgNow.balanceUrl || '').trim() || BALANCE_URL
    if (!key) {
      return { ok: false, code: 'NO_KEY', error: '未配置 API Key（右键小鲸鱼 → 设置）' }
    }
    try {
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(20000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = (data && data.error && (data.error.message || data.error)) || ('HTTP ' + res.status)
        const payload = { ok: false, code: 'HTTP_' + res.status, error: String(msg).slice(0, 200), transient: res.status >= 500 }
        if (!payload.transient) console.error('[whale-pet]', payload.code, payload.error)
        return payload
      }
      const info = Array.isArray(data.balance_infos) && data.balance_infos[0]
      if (!info) return { ok: false, code: 'EMPTY', error: '接口未返回余额数据', transient: true }
      const payload = {
        ok: true,
        totalBalance: info.total_balance,
        currency: info.currency || 'CNY',
        isAvailable: info.is_available !== false,
        grantedBalance: info.granted_balance,
        toppedUpBalance: info.topped_up_balance,
        cachedAt: Date.now(),
      }
      balanceCache = { at: Date.now(), payload }
      // 消耗统计
      if (cfgNow.trackStats) {
        recordBalance(Number(payload.totalBalance))
      }
      // 低余额提醒
      if (cfgNow.lowBalanceAlert && Number(payload.totalBalance) > 0 && Number(payload.totalBalance) < Number(cfgNow.lowThreshold)) {
        notifyLowBalance(payload.totalBalance, payload.currency)
      }
      return payload
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 200)
      if (balanceCache && Date.now() - balanceCache.at < 10 * 60 * 1000) {
        return { ...balanceCache.payload, stale: true, error: msg }
      }
      return { ok: false, code: 'ERROR', error: msg, transient: true }
    } finally {
      balanceInFlight = null
    }
  })()
  return balanceInFlight
}

// ---------------------------------------------------------------------------
// 设置窗口
// ---------------------------------------------------------------------------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 640,
    title: '大肥鱼 · 设置',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  settingsWin.setMenuBarVisibility(false)
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'))
  settingsWin.once('ready-to-show', () => settingsWin.show())
  settingsWin.on('closed', () => { settingsWin = null })
}

// ---------------------------------------------------------------------------
// 显示位置模式：all(全显示) | taskbar(仅任务栏) | tray(仅托盘) | hidden(全隐藏)
// ---------------------------------------------------------------------------
function applyDisplayMode(mode) {
  if (!petWin || petWin.isDestroyed()) return
  const m = mode || 'all'
  // 桌宠本体始终显示，与显示位置无关；置顶只由「始终置顶」决定
  petWin.setAlwaysOnTop(loadConfig().alwaysOnTop !== false, 'screen-saver')
  petWin.show()
  // 任务栏显隐由创建窗口时的 skipTaskbar 决定（运行时切换不可靠，需重建）
  const showTray = (m === 'all' || m === 'tray')
  updateTray(showTray)
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function buildTrayImage() {
  try {
    const p = path.join(__dirname, 'assets', 'DSniang02.png')
    return nativeImage.createFromPath(p).resize({ width: 16, height: 16 })
  } catch {
    return nativeImage.createEmpty()
  }
}

function buildTrayMenu() {
  const clickThrough = loadConfig().clickThrough === true
  return Menu.buildFromTemplate([
    { label: '🔄 立即刷新', click: () => { if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:refresh') } },
    { label: '🖱️ 鼠标穿透', type: 'checkbox', checked: clickThrough, click: () => toggleClickThrough() },
    { label: '💬 对话…', click: () => openChat() },
    { label: '⚙️ 设置…', click: () => openSettings() },
    { label: '✕ 退出', click: () => app.quit() },
  ])
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu())
}

function updateTray(enabled) {
  if (!enabled) {
    if (tray) { tray.destroy(); tray = null }
    return
  }
  if (tray) return
  tray = new Tray(buildTrayImage())
  tray.setToolTip('大肥鱼')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => { if (petWin && !petWin.isDestroyed()) petWin.show() })
}

// ---------------------------------------------------------------------------
// 全局热键
// ---------------------------------------------------------------------------
function updateHotkey(enabled) {
  globalShortcut.unregisterAll()
  // 全隐藏时的安全恢复热键（始终可用）
  try {
    globalShortcut.register('Control+Shift+H', () => {
      const cur = loadConfig().displayMode || 'all'
      const next = cur === 'hidden' ? 'all' : 'hidden'
      cfg = saveConfig({ displayMode: next })
      applyDisplayMode(next)
      if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:config-updated')
    })
  } catch (err) { /* ignore */ }
  // 鼠标穿透快捷开关（始终可用，便于穿透后一键恢复）
  try {
    globalShortcut.register('Control+Shift+X', () => toggleClickThrough())
  } catch (err) { /* ignore */ }
  // 打开对话热键：始终注册（核心功能），不受“全局热键”总开关限制，避免切托盘/后台后失效
  try {
    globalShortcut.register(loadConfig().chatHotkey || 'Alt+Q', () => toggleChat())
  } catch (err) { /* ignore */ }
  if (!enabled) return
  globalShortcut.register('Control+Shift+R', () => {
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:refresh')
  })
}

// 窗口获得焦点时确保“打开对话”热键已注册（防止被系统回收后失效）
function ensureChatHotkey() {
  try { globalShortcut.register(loadConfig().chatHotkey || 'Alt+Q', () => toggleChat()) } catch (err) { /* ignore */ }
}
app.on('browser-window-focus', ensureChatHotkey)

// ---------------------------------------------------------------------------
// 开机自启
// ---------------------------------------------------------------------------
function updateAutoStart(enabled) {
  try {
    // 便携版运行时 process.execPath 指向临时解压目录，注册后开机自启会失效；
    // electron-builder 便携版会注入 PORTABLE_EXECUTABLE_FILE 指向真实的便携版 exe 路径
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: exePath,
      args: [],
    })
    console.log('[whale-pet] autoStart set=' + enabled + ' path=' + exePath)
  } catch (err) {
    console.error('[whale-pet] setLoginItemSettings failed:', err)
  }
}

// ---------------------------------------------------------------------------
// 自定义图片
// ---------------------------------------------------------------------------
async function chooseCustomImage() {
  const r = await dialog.showOpenDialog(settingsWin || petWin, {
    title: '选择鲸鱼图片（建议 1026×1026 PNG）',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false }
  try {
    const src = r.filePaths[0]
    fs.copyFileSync(src, customImagePath())
    cfg = saveConfig({ customImage: true })
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:config-updated')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

// ---------------------------------------------------------------------------
// 对话（Codex）—— 会话存储、codex CLI 桥接、聊天窗口
// ---------------------------------------------------------------------------
const convsPath = () => path.join(app.getPath('userData'), 'conversations.json')
const chatWorkspace = () => {
  const c = loadConfig()
  return (c.chatDir || '').trim() || path.join(app.getPath('userData'), 'chat-workspace')
}
function loadConvs() {
  try {
    const arr = JSON.parse(fs.readFileSync(convsPath(), 'utf8'))
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
function saveConvs(arr) {
  try {
    fs.mkdirSync(path.dirname(convsPath()), { recursive: true })
    fs.writeFileSync(convsPath(), JSON.stringify(arr, null, 2), 'utf8')
  } catch (err) { console.error('[whale-pet] save conversations failed:', err) }
}
function newConvId() { return 'c' + crypto.randomBytes(8).toString('hex') }
function touchConv(c) { c.updatedAt = new Date().toISOString() }

let chatModelsCache = null
let chatModelsAt = 0
function readChatModels() {
  // 短暂缓存：30 秒内不重复读几百 KB 的 models.json，避免拖慢打开对话框
  if (chatModelsCache && Date.now() - chatModelsAt < 30000) return chatModelsCache
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models.json'), 'utf8'))
    const arr = Array.isArray(j.models) ? j.models : []
    const list = arr
      .map((m) => ({ slug: (m && m.slug) || '', displayName: (m && (m.display_name || m.slug)) || '' }))
      .filter((m) => m.slug)
    if (list.length) { chatModelsCache = list; chatModelsAt = Date.now() }
    return list
  } catch { return [] }
}

// 本地模型端点：优先用 config.localBaseUrl，其次回退到 LM Studio 默认端口（127.0.0.1:1234/v1）
function localEndpoint() {
  const u = String(loadConfig().localBaseUrl || '').trim().replace(/\/+$/, '')
  return u || 'http://127.0.0.1:1234/v1'
}
// LM Studio CLI 路径：优先用 config.lmsCli，其次自动探测常见安装位置；找不到返回空
function lmsCliPath() {
  const cfg = String(loadConfig().lmsCli || '').trim()
  if (cfg && fs.existsSync(cfg)) return cfg
  const home = os.homedir()
  const candidates = [
    path.join(home, '.lmstudio', 'bin', 'lms.exe'),
    path.join(home, '.lmstudio', 'bin', 'lms'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'lm-studio', 'bin', 'lms.exe') : '',
  ].filter(Boolean)
  for (const p of candidates) { if (fs.existsSync(p)) return p }
  return ''
}
let lmModelsCache = null
let lmModelsAt = 0
async function readLmModels() {
  // 短暂缓存：30 秒内不重复跑，避免每次打开对话框都阻塞/超时
  if (lmModelsCache && Date.now() - lmModelsAt < 30000) return lmModelsCache
  let got = null
  // 优先用 lms ls --json 读 LM Studio 磁盘上的完整模型索引（异步，不再阻塞主进程）
  const lms = lmsCliPath()
  if (lms) {
    try {
      const out = await new Promise((resolve, reject) => {
        execFile(lms, ['ls', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, stdout) => err ? reject(err) : resolve(stdout))
      })
      const arr = JSON.parse(out)
      const list = (Array.isArray(arr) ? arr : [])
        .filter((m) => m && m.type === 'llm' && m.modelKey)
        .map((m) => ({
          id: m.modelKey,
          displayName: String(m.displayName || m.modelKey).replace(/^.*[\\/]/, '') + ' (本地)',
        }))
      if (list.length) { lmModelsCache = list; lmModelsAt = Date.now(); return list }
    } catch (err) { /* lms 不可用则回退到接口 */ }
  }
  // 回退：/v1/models 接口 + 普适清洗（保证 Ollama / llama.cpp 等其它本地来源仍可读，且不被改坏）
  try {
    const res = await fetch(localEndpoint() + '/models', { signal: AbortSignal.timeout(5000) })
    const data = await res.json()
    const arr = (data && Array.isArray(data.data)) ? data.data : []
    got = arr
      .map((m) => {
        const id = String((m && m.id) || '').trim()
        if (!id) return { id, base: '', ok: false }
        // 过滤 embedding（任何来源）
        if (/(embedding|embed|nomic-embed|bge-|gte-|text-embedding)/i.test(id)) return { id, base: '', ok: false }
        // 脏数据：含 @ 或异常的 LM Studio 占位 id 直接过滤
        if (/@/.test(id) && !/\.gguf$/i.test(id)) return { id, base: '', ok: false }
        // 按“长相”决定显示方式：
        // - 像文件路径/gguf（含 \ / 或 .gguf 后缀）→ 按文件路径清洗
        // - 干净的简单名（如 llama3.1:8b、qwen2.5:7b）→ 原样保留，不乱动
        let base = id
        if (/\.gguf$/i.test(id) || /[\\/]/.test(id)) {
          base = id.replace(/^.*[\\/]/, '').replace(/\.gguf$/i, '')
          base = base
            .replace(/[._-]?(q[248]_[kmlx]+(?:_[a-z0-9]+)?|q[34568]_[a-z0-9_]*|iq[234][_a-z0-9]*|q[23458]_[a-z0-9_]*|q4_0|q4_1|q5_0|q5_1|q8_0|q8_1|q2_k|q3_k|q4_k|q5_k|q6_k|q8_k|bf16|fp16|f16|f32|f8|(?:^|[._-])(?:q[248]_[a-z0-9_]+|iq[234][a-z0-9_]*))$/i, '')
            .replace(/[-_]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
          base = base.replace(/([a-z])([A-Z])/g, '$1 $2').trim()
        }
        if (!base) return { id, base: '', ok: false }
        return { id, base, ok: true }
      })
      .filter((m) => m.ok && m.id)
      .map(({ id, base }) => ({ id, displayName: base + ' (本地)' }))
    if (got && got.length) { lmModelsCache = got; lmModelsAt = Date.now() }
    return got
  } catch { return [] }
}

// 本地模型目录：优先取 config.localModelDir，其次从 config.localModelPath 的目录推导；均未填则留空（此时 gguf 上下文读取走兜底值）
function lmModelsDir() {
  const c = loadConfig()
  const dir = String(c.localModelDir || '').trim()
  if (dir) return dir
  const p = String(c.localModelPath || '').trim()
  return p ? path.dirname(p) : ''
}
const lmMaxCtxCache = {}
function findLmGguf(modelId) {
  try {
    const want = String(modelId || '').split(/[\\/]/).pop().toLowerCase().replace(/\s+/g, '')
    const dir = lmModelsDir()
    if (!dir) return null
    for (const f of fs.readdirSync(dir)) {
      if (String(f).toLowerCase().replace(/\s+/g, '') === want) return path.join(dir, f)
    }
  } catch { /* ignore */ }
  return null
}
function readGgufCtx(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const rd = (n, off) => { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, off); return b }
    if (rd(4, 0).toString('utf8') !== 'GGUF') { fs.closeSync(fd); return null }
    const nKV = Number(rd(8, 16).readBigUInt64LE(0))
    let off = 24
    const skipVal = (t) => {
      if (t === 8) { const l = Number(rd(8, off).readBigUInt64LE(0)); off += 8 + l }
      else if (t === 9) { const et = rd(4, off).readUInt32LE(0); off += 4; const cnt = Number(rd(8, off).readBigUInt64LE(0)); off += 8; for (let i = 0; i < cnt; i++) skipVal(et) }
      else if (t === 10 || t === 11 || t === 12) off += 8
      else if (t === 4 || t === 5 || t === 6) off += 4
      else if (t === 2 || t === 3) off += 2
      else off += 1
    }
    for (let i = 0; i < nKV; i++) {
      const kl = Number(rd(8, off).readBigUInt64LE(0)); off += 8
      const key = rd(kl, off).toString('utf8'); off += kl
      const vt = rd(4, off).readUInt32LE(0); off += 4
      if (/context_length/i.test(key)) {
        let v = null
        if (vt === 4) v = rd(4, off).readUInt32LE(0)
        else if (vt === 10) v = Number(rd(8, off).readBigUInt64LE(0))
        fs.closeSync(fd)
        return v
      }
      skipVal(vt)
    }
    fs.closeSync(fd)
    return null
  } catch { return null }
}
let lmCtxCache = 0
let lmCtxAt = 0
function getLmMaxCtx(modelId) {
  if (lmCtxCache && Date.now() - lmCtxAt < 60000) return lmCtxCache
  // 优先：读 LM Studio 报告的运行上下文（lms ps），最可靠
  try {
    const lms = lmsCliPath()
    if (lms) {
      const out = execFileSync(lms, ['ps', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      const arr = JSON.parse(out)
      const m = (Array.isArray(arr) ? arr : []).find((x) => x && (x.contextLength || x.maxContextLength))
      if (m) {
        const c = Number(m.contextLength || m.maxContextLength || 0)
        if (c > 0) { lmCtxCache = c; lmCtxAt = Date.now(); return lmCtxCache }
      }
    }
  } catch (err) { /* ignore */ }
  // 其次：读正在运行的 llama-server 的 --ctx-size（LM Studio 实际设置）
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -notmatch 'pwsh|powershell|cmd|cscript|wscript' -and $_.CommandLine -match '--ctx-size' -and $_.CommandLine -match '\\.gguf' } | Select-Object -First 1 -ExpandProperty CommandLine"], { encoding: 'utf8' })
    const m = /--ctx-size[= ]\s*(\d+)/.exec(out || '')
    if (m) { lmCtxCache = parseInt(m[1], 10); lmCtxAt = Date.now(); return lmCtxCache }
  } catch (err) { /* ignore */ }
  // 兜底：读 gguf 上限
  const file = findLmGguf(modelId)
  const v = file ? readGgufCtx(file) : null
  lmCtxCache = (v && v > 0) ? v : 32768
  lmCtxAt = Date.now()
  return lmCtxCache
}
function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0, other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++
    else if (!/\s/.test(ch)) other++
  }
  return Math.ceil(cjk + other / 3.6)
}
// ---------- 本地模型 MCP 安全层（只读白名单 + 语句级校验 + 预算守卫） ----------
const LOCAL_WRITE_TOOL_RE = /(write|edit|update|delete|remove|drop|create|insert|alter|truncate|rename|move|copy|mkdir|makedir|append|replace|save|put|upload|overwrite|unlink|rmdir)/i
const LOCAL_GENERIC_TOOL_RE = /(mysql_query|sql_query|query|execute|exec|run|script|command|shell|call|statement|ddl|dml)/i
const LOCAL_READ_TOOL_RE = /^(get|list|read|search|select|show|describe|desc|count|query|lookup|find|info|stat|preview|peek|head|top|schema|cat|ls|dir|tree)/i

function isLocalSafeTool(t) {
  const n = String((t && (t.toolName || t.name)) || '')
  const full = String((t && (t.name || t.toolName)) || '')
  // 所有 whale_ 前缀都是内置工具（生图/Excel/文件读写/文档生成），白名单放行——内置逻辑自带安全校验与确认
  // 注意：内置工具的 toolName 不带 whale_ 前缀（如 write_file），必须用完整 name 判断
  if (/^whale_/.test(full) || /^whale_/.test(n)) return true
  if (n === 'whale_generate_image' || n === 'generate_image') return true // 内置生图工具：白名单放行（执行时另有确认）
  if (n === 'whale_create_xlsx' || n === 'create_xlsx') return true // 内置 Excel 工具：白名单放行（执行时用 Python 生成 xlsx）
  if (LOCAL_WRITE_TOOL_RE.test(n)) return false
  if (LOCAL_GENERIC_TOOL_RE.test(n)) return true // 通用执行器放行，执行前做语句级只读校验
  return LOCAL_READ_TOOL_RE.test(n)
}

function isReadOnlySql(sql) {
  const s = String(sql || '').trim()
  if (!s || s.length > 300) return false
  if (s.includes(';')) return false // 拒绝多语句
  if (!/^(select|show|describe|desc|explain|pragma|with)\b/i.test(s)) return false
  if (/(insert\s+into|update\s+|delete\s+from|drop\s+table|alter\s+table|truncate\s|create\s+table|replace\s+into|grant\s|revoke\s|set\s+sql)/i.test(s)) return false
  return true
}

function guardLocalToolCall(meta, def, args) {
  const n = String((meta && meta.toolName) || '').toLowerCase()
  const a = args || {}
  const sql = String(a.sql ?? a.query ?? a.queryText ?? a.statement ?? a.script ?? a.command ?? a.code ?? a.shell ?? '')
  if (LOCAL_GENERIC_TOOL_RE.test(n)) {
    if (!sql.trim()) return { ok: false, reason: '（本地只读模式）已拒绝：通用执行工具未提供可校验的语句，仅允许只读查询' }
    if (!isReadOnlySql(sql)) return { ok: false, reason: '（本地只读模式）已拒绝非只读语句：' + String(sql).slice(0, 160) }
  }
  return { ok: true }
}

// 危险/写操作工具：执行前弹本地确认框，避免 AI 闷头删改用户文件
const CONFIRM_WRITE_RE = /(write_file|overwrite|delete_file|remove_file|unlink|rmdir|delete|create_docx|create_pdf|create_pptx|update|rename|move|copy|mkdir|insert|drop|alter|truncate|create|replace|grant|filesystem|multiedit|multi_edit|shortcut|clipboard|scrape)/i
// 系统命令/操作类工具（windows-mcp 等）：执行命令、启动应用、改注册表、操作进程等
const CONFIRM_SYSTEM_RE = /(execute|exec|command|launch|start|run|install|uninstall|registry|reg_|process|task|kill|shutdown|restart|shell|cmd|powershell|click|press|type|open_url|create_process|script|app$|\bapp\b|multi_select|power_shell|fs_|windows_)/i
function toolNeedsConfirm(meta, args) {
  const n = String((meta && meta.toolName) || '').toLowerCase()
  const a = args || {}
  const sql = String(a.sql ?? a.query ?? a.queryText ?? a.statement ?? a.command ?? a.script ?? a.code ?? a.shell ?? '')
  // 纯只读 SQL 无需确认
  if (isReadOnlySql(sql) && !CONFIRM_WRITE_RE.test(n)) return false
  if (CONFIRM_WRITE_RE.test(n)) return true
  if (CONFIRM_SYSTEM_RE.test(n)) return true
  return false
}
async function confirmDangerousTool(meta, args) {
  const n = String((meta && meta.toolName) || '')
  const a = args || {}
  const pathHint = String(a.path || a.filePath || a.file || a.dest || a.target || a.uri || '').slice(0, 120)
  const cmdHint = String(a.command || a.script || a.code || a.sql || a.queryText || a.url || '').slice(0, 80)
  const detail = '模型想执行：' + n
    + (pathHint ? '\n路径/对象：' + pathHint : '')
    + (cmdHint ? '\n命令/内容：' + cmdHint : '')
    + '\n\n这可能会改动文件、执行命令或操作系统。要继续吗？'
  const r = await dialog.showMessageBox(chatWin || petWin, {
    type: 'warning',
    buttons: ['允许执行', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '大肥鱼想执行一个写操作',
    message: '确认让桌宠执行这个操作吗？',
    detail,
  })
  return r.response === 0
}
async function runBuiltinGenerateImage(args) {
  const a = args || {}
  const prompt = String(a.prompt || '').trim()
  if (!prompt) return { text: '生图失败：缺少提示词 prompt', isError: true }
  const width = Math.max(256, Math.min(1024, parseInt(a.width, 10) || 512))
  const height = Math.max(256, Math.min(1024, parseInt(a.height, 10) || 512))
  const steps = Math.max(4, Math.min(40, parseInt(a.steps, 10) || 12))
  const ws = chatWorkspace()
  const candidates = [
    path.join(ws, 'whale-gpu.ps1'),
  ]
  let script = candidates.find((p) => fs.existsSync(p))
  if (!script) return { text: '生图失败：找不到 whale-gpu.ps1，请先配置本地 ComfyUI 环境', isError: true }
  const out = path.join(ws, 'whale-img-' + Date.now() + '.png')
  try {
    const o = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'generate', prompt, '-Out', out, '-Width', String(width), '-Height', String(height), '-Steps', String(steps)], { encoding: 'utf8', windowsHide: true, timeout: 300000 })
    return { text: '生图完成：' + out + (o ? '\n' + String(o).trim().slice(0, 300) : '') }
  } catch (err) {
    return { text: '生图失败：' + String(err && err.message || err), isError: true }
  }
}

// 内置 Excel 工具：不依赖外部 MCP 服务器，用本机 Python + openpyxl 直接生成 xlsx
const BUILTIN_XLSX_PY = `# -*- coding: utf-8 -*-
import json, sys, os
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
out = payload["out"]
rows = payload.get("rows")
text = payload.get("text", "")
if not isinstance(rows, list):
    rows = []
    for ln in str(text).splitlines():
        ln = ln.strip()
        if not ln:
            continue
        if "\\t" in ln:
            rows.append([c.strip() for c in ln.split("\\t")])
        elif "," in ln:
            rows.append([c.strip() for c in ln.split(",")])
        else:
            rows.append([ln])
has_header = bool(payload.get("header", True))
wb = Workbook()
ws = wb.active
ws.title = "Sheet1"
fill = PatternFill(start_color="FF1F3864", end_color="FF1F3864", fill_type="solid")
head_font = Font(bold=True, color="FFFFFFFF")
thin = Side(style="thin", color="FFCCCCCC")
border = Border(left=thin, right=thin, top=thin, bottom=thin)
for r_idx, row in enumerate(rows):
    cells = list(row) if isinstance(row, (list, tuple)) else [row]
    for c_idx, val in enumerate(cells):
        cell = ws.cell(row=r_idx + 1, column=c_idx + 1, value=val)
        cell.border = border
        cell.alignment = Alignment(vertical="center")
        if has_header and r_idx == 0:
            cell.font = head_font
            cell.fill = fill
            cell.alignment = Alignment(vertical="center", horizontal="center")
for col in ws.columns:
    max_len = 0
    for cell in col:
        v = cell.value
        if v is not None:
            s = str(v)
            max_len = max(max_len, sum(2 if ord(ch) > 127 else 1 for ch in s))
    if max_len:
        ws.column_dimensions[col[0].column_letter].width = min(max(max_len * 1.2, 8), 50)
wb.save(out)
print("OK")
`
async function runBuiltinCreateXlsx(args) {
  const a = args || {}
  const target = String(a.path || a.filePath || '').trim()
  if (!target) return { text: '生成 Excel 失败：缺少文件路径 path', isError: true }
  // 只允许写入绝对路径（本地磁盘）
  if (!/^[A-Za-z]:[\\/]/.test(target)) return { text: '生成 Excel 失败：path 必须是本地绝对路径（如 E:\\Desktop\\x.xlsx）', isError: true }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
  } catch (err) { return { text: '生成 Excel 失败：无法创建目录 ' + path.dirname(target) + '：' + err.message, isError: true } }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-xlsx-'))
  const inJson = path.join(tmp, 'input.json')
  const script = path.join(tmp, 'build_xlsx.py')
  const payload = { out: target, rows: Array.isArray(a.rows) ? a.rows : undefined, text: String(a.text ?? ''), header: a.header !== false }
  try {
    fs.writeFileSync(inJson, JSON.stringify(payload), 'utf8')
    fs.writeFileSync(script, BUILTIN_XLSX_PY, 'utf8')
    const res = execFileSync('python', [script, inJson], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
    return { text: '已创建 ' + target + (res ? '\n' + String(res).trim().slice(0, 200) : '') }
  } catch (err) {
    return { text: '生成 Excel 失败：' + String(err && err.message || err).slice(0, 500), isError: true }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (err) { /* ignore */ }
  }
}

// 内置文档构建：docx / pdf / pptx 用一个内嵌 Python 脚本生成（复用 python-docx / reportlab / python-pptx）
const BUILTIN_DOC_PY = `# -*- coding: utf-8 -*-
import json, sys
from pathlib import Path
payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
kind = payload["kind"]
out = payload["out"]
text = payload.get("text", "")
slides = max(1, int(payload.get("slides") or 1))
if kind == "docx":
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
    from docx.shared import Inches, Pt
    doc = Document()
    sec = doc.sections[0]
    sec.page_width = Inches(8.5); sec.page_height = Inches(11)
    for a in ("top_margin","right_margin","bottom_margin","left_margin"):
        setattr(sec, a, Inches(1))
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"; normal.font.size = Pt(11)
    pf = normal.paragraph_format
    pf.alignment = WD_ALIGN_PARAGRAPH.LEFT
    pf.space_before = Pt(0); pf.space_after = Pt(6)
    pf.line_spacing = 1.25; pf.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    doc.add_paragraph(text)
    doc.save(out)
elif kind == "pdf":
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate
    try: pdfmetrics.registerFont(TTFont("Calibri", r"C:\\Windows\\Fonts\\calibri.ttf"))
    except Exception: pdfmetrics.registerFont(TTFont("Calibri", r"C:\\Windows\\Fonts\\arial.ttf"))
    style = ParagraphStyle("Body", fontName="Calibri", fontSize=11, leading=11*1.25, spaceBefore=0, spaceAfter=6, alignment=0)
    doc = SimpleDocTemplate(out, pagesize=letter, leftMargin=1*inch, rightMargin=1*inch, topMargin=1*inch, bottomMargin=1*inch, title=text)
    doc.build([Paragraph(text, style)])
elif kind == "pptx":
    from pptx import Presentation
    from pptx.util import Inches, Pt
    from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
    from pptx.dml.color import RGBColor
    slides_text = payload.get("slides_text")
    per_slide = isinstance(slides_text, list) and len(slides_text) > 0
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]
    NAVY = RGBColor(0x1F, 0x38, 0x64)
    DARK = RGBColor(0x33, 0x33, 0x33)
    WHITE = RGBColor(0xFF, 0xFF, 0xFF)
    ACCENT = RGBColor(0x2E, 0x86, 0xC1)
    GRAY = RGBColor(0x99, 0x99, 0x99)
    # 页面来源：优先 slides_text（数组每项一页），否则把 text 按 --- 拆成多页
    pages = []
    if per_slide:
        pages = [str(x) for x in slides_text]
    else:
        raw = str(text)
        for seg in raw.split('---'):
            seg_lines = [ln.strip() for ln in seg.splitlines() if ln.strip()]
            if seg_lines:
                pages.append('\\n'.join(seg_lines))
        if not pages and raw.strip():
            pages = [raw.strip()]
    if not pages:
        pages = [""]
    for idx, page in enumerate(pages, start=1):
        lines = [ln.strip() for ln in str(page).splitlines() if ln.strip()]
        title = lines[0] if lines else ("第" + str(idx) + "页")
        body_items = lines[1:]
        slide = prs.slides.add_slide(blank)
        # 顶部标题色带
        band = slide.shapes.add_shape(1, 0, 0, prs.slide_width, Inches(1.2))
        band.fill.solid(); band.fill.fore_color.rgb = NAVY
        band.line.fill.background()
        band.shadow.inherit = False
        tb = slide.shapes.add_textbox(Inches(0.7), Inches(0.12), prs.slide_width - Inches(1.4), Inches(1.0))
        tf = tb.text_frame; tf.word_wrap = True; tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = tf.paragraphs[0]; r = p.add_run(); r.text = title
        r.font.size = Pt(30); r.font.bold = True; r.font.color.rgb = WHITE
        # 正文区
        body = slide.shapes.add_textbox(Inches(1.0), Inches(1.7), prs.slide_width - Inches(2.0), prs.slide_height - Inches(2.3))
        bf = body.text_frame; bf.word_wrap = True
        para_idx = 0
        for item in body_items:
            is_bullet = item.startswith('-') or item.startswith('•') or item.startswith('*')
            clean = item.lstrip('-•* ').strip()
            p2 = bf.paragraphs[0] if para_idx == 0 else bf.add_paragraph()
            para_idx += 1
            p2.space_after = Pt(10)
            if clean.endswith(':'):
                r2 = p2.add_run(); r2.text = clean
                r2.font.size = Pt(20); r2.font.bold = True; r2.font.color.rgb = ACCENT
            elif is_bullet:
                r2 = p2.add_run(); r2.text = "•  " + clean
                r2.font.size = Pt(18); r2.font.color.rgb = DARK
            else:
                r2 = p2.add_run(); r2.text = clean
                r2.font.size = Pt(16); r2.font.color.rgb = DARK
        # 页码
        pn = slide.shapes.add_textbox(prs.slide_width - Inches(1.6), prs.slide_height - Inches(0.6), Inches(1.2), Inches(0.4))
        pfp = pn.text_frame.paragraphs[0]; pfp.alignment = PP_ALIGN.RIGHT
        pr_ = pfp.add_run(); pr_.text = str(idx) + " / " + str(len(pages))
        pr_.font.size = Pt(12); pr_.font.color.rgb = GRAY
    prs.save(out)
else:
    raise SystemExit("unknown kind: " + kind)
print("OK")
`
async function runBuiltinDocTool(args, kind) {
  const a = args || {}
  const target = String(a.path || a.filePath || '').trim()
  if (!target) return { text: '生成文档失败：缺少文件路径 path', isError: true }
  if (!/^[A-Za-z]:[\\/]/.test(target)) return { text: '生成文档失败：path 必须是本地绝对路径', isError: true }
  try { fs.mkdirSync(path.dirname(target), { recursive: true }) } catch (err) { return { text: '生成文档失败：无法创建目录 ' + path.dirname(target) + '：' + err.message, isError: true } }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-doc-'))
  const inJson = path.join(tmp, 'input.json')
  const script = path.join(tmp, 'build_doc.py')
  const payload = { kind, out: target, text: String(a.text ?? ''), slides: Math.max(1, parseInt(a.slides, 10) || 1), slides_text: Array.isArray(a.slides_text) ? a.slides_text.map(String) : undefined }
  try {
    fs.writeFileSync(inJson, JSON.stringify(payload), 'utf8')
    fs.writeFileSync(script, BUILTIN_DOC_PY, 'utf8')
    const res = execFileSync('python', [script, inJson], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
    return { text: '已创建 ' + target + (res ? '\n' + String(res).trim().slice(0, 200) : '') }
  } catch (err) {
    return { text: '生成文档失败：' + String(err && err.message || err).slice(0, 500), isError: true }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (err) { /* ignore */ }
  }
}

// 内置文件系统工具：本机磁盘读写，零依赖
function runBuiltinFilesystemTool(meta, args) {
  const a = args || {}
  const n = String(meta && meta.toolName || '')
  const target = String(a.path || '').trim()
  if (!target) return { text: '缺少路径 path', isError: true }
  if (n === 'list_dir') {
    try { return { text: fs.readdirSync(target, { withFileTypes: true }).map((e) => (e.isDirectory() ? '[dir] ' : '') + e.name).join('\n') } }
    catch (err) { return { text: '列目录失败：' + err.message, isError: true } }
  }
  if (n === 'read_file') {
    try { return { text: String(fs.readFileSync(target, 'utf8')).slice(0, 4000) } }
    catch (err) { return { text: '读文件失败：' + err.message, isError: true } }
  }
  if (n === 'write_file') {
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, String(a.content ?? ''), 'utf8'); return { text: '已写入 ' + target } }
    catch (err) { return { text: '写文件失败：' + err.message, isError: true } }
  }
  if (n === 'delete_file') {
    try { const st = fs.lstatSync(target); if (st.isDirectory()) return { text: '只支持删除单个文件，不允许删除目录', isError: true }; fs.unlinkSync(target); return { text: '已删除 ' + target } }
    catch (err) { return { text: '删除失败：' + err.message, isError: true } }
  }
  return { text: '未知内置文件工具: ' + n, isError: true }
}

// 写/删操作前：把目标文件备份到 chat-workspace/backups，供出问题回滚
const BACKUP_WRITE_TOOL = /(write_file|overwrite|delete_file|remove_file|unlink|rmdir|create_docx|create_pdf|create_pptx|rename|move|copy)/i
function backupBeforeWrite(meta, args) {
  const n = String((meta && meta.toolName) || '').toLowerCase()
  if (!BACKUP_WRITE_TOOL.test(n)) return null
  const a = args || {}
  const target = String(a.path || a.filePath || a.file || a.dest || a.target || a.uri || '').trim()
  if (!target) return null
  if (!/^[A-Za-z]:[\\/]/.test(target)) return null // 只备份本地绝对路径（相对路径/远程对象跳过）
  try {
    if (!fs.existsSync(target)) return null
    const ws = chatWorkspace()
    const bakDir = path.join(ws, 'backups')
    fs.mkdirSync(bakDir, { recursive: true })
    const base = path.basename(target)
    const bak = path.join(bakDir, Date.now() + '-' + base)
    fs.copyFileSync(target, bak)
    return bak
  } catch (err) { return null }
}
async function execMcpToolCall(meta, def, args) {
  // 内置生图工具：直接调 whale-gpu.ps1（生图是写/重显存操作，先确认）
  if (meta && meta.builtin === 'generate_image') {
    const ok = await confirmDangerousTool({ toolName: 'generate_image' }, args)
    if (!ok) return { text: '（用户已取消生图）', isError: true }
    return await runBuiltinGenerateImage(args)
  }
  // 内置 Excel 工具：直接用本机 Python + openpyxl 生成 xlsx
  if (meta && meta.builtin === 'create_xlsx') {
    return await runBuiltinCreateXlsx(args)
  }
  // 内置文件读写工具：本机磁盘操作，零依赖
  if (meta && meta.builtin && ['list_dir', 'read_file', 'write_file', 'delete_file'].includes(meta.builtin)) {
    return runBuiltinFilesystemTool(meta, args)
  }
  // 内置文档生成工具：docx / pdf / pptx
  if (meta && meta.builtin && ['create_docx', 'create_pdf', 'create_pptx'].includes(meta.builtin)) {
    return await runBuiltinDocTool(args, meta.builtin.replace('create_', ''))
  }
  // 写/删操作：先备份目标文件
  const bak = backupBeforeWrite(meta, args)
  // 先做只读拦截
  if (def.localReadOnly !== false) {
    const guard = guardLocalToolCall(meta, def, args)
    if (!guard.ok) return { text: guard.reason, isError: true }
  }
  // 危险/写操作：先确认
  if (toolNeedsConfirm(meta, args)) {
    const ok = await confirmDangerousTool(meta, args)
    if (!ok) return { text: '（用户已取消这个写操作）', isError: true }
  }
  const c = mcp.getClient(def)
  await c.connect()
  let r
  try { r = await c.call(meta.toolName, args) }
  catch (err) { return { text: '工具调用失败：' + String(err && err.message || err), isError: true } }
  if (bak && r && r.text) r.text += '\n（已备份原文件：' + bak + '，可通过它回滚）'
  if (bak && !r) r = { text: '（已备份原文件：' + bak + '）' }
  return r
}

function buildLocalMcpTools(enabled) {
  const cfg = loadConfig()
  let budget = 6000 // 工具 schema 的 token 预算（内置文件/文档工具较多，需保证全部注入；生成类任务历史短）
  const out = []
  for (const t of (enabled || [])) {
    const def = (cfg.mcps || []).find((d) => d.id === t.serverId)
    const allowFull = def && def.localReadOnly === false
    if (!allowFull && !isLocalSafeTool(t)) continue
    const payload = { type: 'function', function: { name: t.name, description: String(t.description || '').slice(0, 200), parameters: t.inputSchema } }
    const cost = estimateTokens(JSON.stringify(payload))
    if (cost > budget) { if (!out.length) continue; else break }
    budget -= cost
    out.push(payload)
  }
  return out
}
function convTokens(conv) {
  return (conv && conv.messages || []).reduce((s, m) => s + estimateTokens(m.content || '') + 5, 0)
}

// 视觉能力判定：优先使用用户手动开关，否则按已知的多模态模型名称自动识别
const VISION_RE = /(vl|vision|qwen3\.5|qwen3vl|qwen2\.5-vl|qwen2-vl|llava|gemma-3|minicpm|phi-3-vision|moondream|pixtral|internvl|gpt-4o|gpt-4\.1|gpt-5)/i
function isVisionModel(model) { return !!(model && VISION_RE.test(String(model))) }
function resolveVision(model) {
  const force = loadConfig().chatForceVision
  if (typeof force === 'boolean') return force
  return isVisionModel(model)
}

// 收集 MCP 服务器上的工具（含开关状态），返回 {tools, byName}
let mcpToolCache = null
let mcpToolAt = 0
// 这些功能已由桌宠"内置 MCP"覆盖（whale_*），外部服务器再提供同名工具就会重复，直接跳过
const BUILTIN_TOOL_SET = new Set(['list_dir', 'read_file', 'write_file', 'delete_file', 'create_docx', 'create_pdf', 'create_pptx', 'create_xlsx', 'generate_image'])
// 判断某外部服务器是否"纯重复"——它的工具全部被内置覆盖（如 qwen-files 只有文件/文档工具），这类开关不再显示
function isBuiltinDupServer(def) {
  if (!def) return false
  const sig = (def.command || '') + ' ' + ((def.args || []).join(' '))
  // 现成判断1：命令指向 _qwen_mcp_server.mjs（本地文件/文档工具），全被内置覆盖
  if (/[_\\/]\s*qwen_mcp_server\.mjs/i.test(sig)) return true
  // 现成判断2：@modelcontextprotocol/server-filesystem（外部文件系统服务器，功能与内置文件工具重复）
  if (/server-filesystem|\bmodelcontextprotocol\/server-filesystem\b/i.test(sig)) return true
  return false
}
async function collectMcpTools(force) {
  if (mcpToolCache && !force && (Date.now() - mcpToolAt) < 30000) return mcpToolCache
  const cfg = loadConfig()
  const servers = (cfg.mcps || []).filter((def) => (!cfg.mcpServersOn || cfg.mcpServersOn[def.id] !== false) && !isBuiltinDupServer(def))
  const tools = []
  const byName = new Map()
  await Promise.all(servers.map(async (def) => {
    try {
      const c = mcp.getClient(def)
      await c.connect()
      const t = await c.listTools()
      for (const tool of t) {
        // 去重：内置工具已覆盖的功能，跳过外部同名工具（避免模型看到两套做同一件事的工具）
        if (BUILTIN_TOOL_SET.has(tool.name)) continue
        const openaiName = mcp.toolKey(def.id, tool.name)
        byName.set(openaiName, { serverId: def.id, serverName: def.name, toolName: tool.name })
        tools.push({
          name: openaiName, description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
          on: true,
          serverId: def.id, serverName: def.name, toolName: tool.name,
        })
      }
    } catch (err) { /* 该 server 连不上则跳过 */ }
  }))
  // 内置生图工具：不依赖外部 MCP 服务器，直接调 whale-gpu.ps1（文本/生图显存自动互斥）
  if (loadConfig().chatMcp === true) {
    byName.set('whale_generate_image', { id: '__builtin__', serverId: '__builtin__', serverName: '内置', toolName: 'generate_image', builtin: 'generate_image' })
    tools.push({
      name: 'whale_generate_image',
      description: '用本地 ComfyUI 生图。参数 prompt 为中文或英文提示词；width/height 建议 512~768；steps 建议 8~16。会自动停文本模型、生图后恢复。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '要生成的图像描述（建议中文）' },
          width: { type: 'number', description: '宽，默认 512' },
          height: { type: 'number', description: '高，默认 512' },
          steps: { type: 'number', description: '步数，默认 12' },
        },
        required: ['prompt'],
      },
      on: true,
      serverId: '__builtin__', serverName: '内置', toolName: 'generate_image',
    })
    // 内置 Excel 工具：不依赖外部 MCP 服务器，直接生成 xlsx（用本机 Python + openpyxl，装好即用）
    byName.set('whale_create_xlsx', { id: '__builtin__', serverId: '__builtin__', serverName: '内置', toolName: 'create_xlsx', builtin: 'create_xlsx' })
    tools.push({
      name: 'whale_create_xlsx',
      description: '生成 Excel（.xlsx）表格文件。传 path（保存路径）和 text（每行一条数据、逗号分列、首行是表头），工具自动转成 Excel。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '保存路径（.xlsx）' },
          text: { type: 'string', description: '表格内容：每行一条数据、逗号分列、首行是表头' },
        },
        required: ['path', 'text'],
      },
      on: true,
      serverId: '__builtin__', serverName: '内置', toolName: 'create_xlsx',
    })
    // 内置文件工具：本机磁盘读写，零依赖（不依赖外部 MCP 脚本 / COM: 占位符）
    const builtinFileTools = [
      { name: 'whale_list_dir', desc: '列出目录下的文件和子目录', tool: 'list_dir', schema: { type: 'object', properties: { path: { type: 'string', description: '目录路径' } }, required: ['path'] } },
      { name: 'whale_read_file', desc: '读取文本文件内容', tool: 'read_file', schema: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] } },
      { name: 'whale_write_file', desc: '创建新文件或覆盖写入已有文本文件', tool: 'write_file', schema: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '要写入的完整文件内容' } }, required: ['path', 'content'] } },
      { name: 'whale_delete_file', desc: '删除单个文件（不允许删除目录）', tool: 'delete_file', schema: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] } },
      { name: 'whale_create_docx', desc: '生成 Word 文档（.docx）。仅当用户明确要 Word 文档/文字稿/.docx 时才用。生成 PPT/演示文稿/幻灯片请用 whale_create_pptx。传 path 和 text。', tool: 'create_docx', schema: { type: 'object', properties: { path: { type: 'string', description: '保存路径（.docx）' }, text: { type: 'string', description: '文档正文内容' } }, required: ['path', 'text'] } },
      { name: 'whale_create_pdf', desc: '生成一个 PDF 文档。你只需提供 path（保存路径）和 text（文档文字内容），工具自动生成 PDF，无需你关心格式。', tool: 'create_pdf', schema: { type: 'object', properties: { path: { type: 'string', description: '保存路径（.pdf）' }, text: { type: 'string', description: '文档正文内容' } }, required: ['path', 'text'] } },
      { name: 'whale_create_pptx', desc: '生成 PowerPoint 演示文稿/幻灯片（.pptx）。用户说生成 PPT/演示文稿/幻灯片/讲稿演示时，用这个工具（不要用 Word）。传 path（.pptx 路径）和 text（每页内容用 --- 分隔，每页第一行是标题）。', tool: 'create_pptx', schema: { type: 'object', properties: { path: { type: 'string', description: '保存路径（.pptx）' }, text: { type: 'string', description: '每页内容，页间用 --- 分隔，每页首行为标题' }, slides: { type: 'integer', description: '页数，默认 1' }, slides_text: { type: 'array', items: { type: 'string' }, description: '每页内容数组（可选）' } }, required: ['path', 'text'] } },
    ]
    for (const t of builtinFileTools) {
      byName.set(t.name, { id: '__builtin__', serverId: '__builtin__', serverName: '内置', toolName: t.tool, builtin: t.tool })
      tools.push({ name: t.name, description: t.desc, inputSchema: t.schema, on: true, serverId: '__builtin__', serverName: '内置', toolName: t.tool })
    }
  }
  mcpToolCache = { tools, byName }
  mcpToolAt = Date.now()
  return mcpToolCache
}

// 直接调用 LM Studio（OpenAI 兼容）聊天，流式返回
async function runLmStudio(conv, model, imagePath, onDelta, onDone, onStatus) {
  const cd = chatWorkspace()
  try { fs.mkdirSync(cd, { recursive: true }) } catch (err) { /* ignore */ }
  const isVision = resolveVision(model)
  const messages = [{ role: 'system', content: LLM_SYSTEM_PROMPT }].concat((conv.messages || []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })))
  if (!messages.length) { onDone({ error: '没有可发送的内容' }); return }
  // 本地模式必须给模型：未选择时自动取第一个可用模型；没有则友好报错
  let useModel = (model && String(model).trim()) || ''
  if (!useModel) {
    const lms = await readLmModels()
    const ids = lms.map((m) => m.id)
    useModel = ids.find((id) => !/@/.test(id)) || ids[0] || ''
  }
  if (!useModel) {
    onDone({ error: '没有可用的本地模型。请先在 LM Studio 里加载模型，或在顶部选择一个模型。' })
    return
  }
  if (onStatus) onStatus('大肥鱼：正在思考…')
  // 视觉模型 + 有截图时，把图片作为多模态内容附到最后一条用户消息
  if (imagePath && isVision) {
    try {
      const imgB64 = fs.readFileSync(imagePath).toString('base64')
      const ext = (String(imagePath).match(/\.([A-Za-z0-9]+)$/) || [null, 'png'])[1].toLowerCase()
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png'
      const last = messages[messages.length - 1]
      if (last && last.role === 'user') {
        last.content = [
          { type: 'text', text: last.content },
          { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + imgB64 } },
        ]
      }
    } catch (err) { /* ignore */ }
  } else if (imagePath) {
    const last = messages[messages.length - 1]
    if (last && last.role === 'user') {
      last.content = String(last.content || '') + '\n（用户附带了一张图片，但当前本地模型不支持看图，请切换到 qwen3vl 等视觉模型）'
    }
  }
  // 收集已开启的 MCP 工具
  let toolsPayload = null
  let byName = new Map()
  if (loadConfig().chatMcp === true) {
    try {
      const mc = await Promise.race([
        collectMcpTools(),
        new Promise((res) => setTimeout(() => res({ tools: [], byName: new Map() }), 8000)),
      ])
      const enabled = (mc.tools || []).filter((t) => t.on)
      if (enabled.length) {
        toolsPayload = buildLocalMcpTools(enabled)
        byName = mc.byName
      }
    } catch (err) { /* 工具不可用则正常纯文本 */ }
  }

  const MAX_ROUNDS = 6
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const out = await lmStreamChat(messages, useModel, toolsPayload, onDelta)
    if (out.error) { onDone({ error: out.error }); return }
    const tcs = out.toolCalls || []
    if (tcs.length) {
      if (onStatus) onStatus('大肥鱼：正在调用工具…')
      messages.push({
        role: 'assistant',
        content: out.text || '',
        tool_calls: tcs.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } })),
      })
      for (const tc of tcs) {
        let result = ''
        const meta = byName.get(tc.name)
        if (meta) {
          try {
            if (meta.serverId === '__builtin__') {
              // 内置工具（生图/Excel/文件/文档）：不依赖外部 mcps 服务器，直接执行
              const r = await execMcpToolCall(meta, null, tc.args)
              result = (r && r.text) || ''
            } else {
              const def = (loadConfig().mcps || []).find((d) => d.id === meta.serverId)
              if (def) {
                const r = await execMcpToolCall(meta, def, tc.args)
                result = (r && r.text) || ''
              } else result = '工具服务器未配置'
            }
          } catch (err) { result = '工具调用失败：' + String(err && err.message || err) }
        } else { result = '未知工具' }
        if (round === 0 && onDelta) onDelta('[正在调用工具 ' + tc.name.split('_').pop() + '…]')
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
      }
      continue
    }
    if (out.text) { onDelta && onDelta(out.text); onDone({ text: out.text }) }
    else if (out.reasoning) { onDelta && onDelta(out.reasoning); onDone({ text: out.reasoning }) }
    else onDone({ error: 'LM Studio 没有返回内容' })
    return
  }
  onDone({ error: '工具调用轮次过多，已停止' })
}

// 单次流式请求：累积文字和 tool_calls，返回 {text, toolCalls, error}
async function lmStreamChat(messages, useModel, toolsPayload, onDelta, opts) {
  // opts: { baseUrl, apiKey, source }  —— 默认走本地 LM Studio；传 baseUrl 时走任意 OpenAI 兼容接口
  const ep = (opts && opts.baseUrl) ? String(opts.baseUrl).replace(/\/+$/, '') : localEndpoint()
  const srcHeaders = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.apiKey) ? { Authorization: 'Bearer ' + opts.apiKey } : {})
  const thinking = loadConfig().chatThinking !== false
  // 关闭思考(reasoning_effort:'none')时模型直接出正文；开启时保留思考，提供更大生成长度
  const body = { model: useModel, messages, stream: true, temperature: 0.5, max_tokens: thinking ? 3072 : 2048 }
  if (!thinking) body.reasoning_effort = 'none'
  if (toolsPayload && toolsPayload.length) { body.tools = toolsPayload; body.tool_choice = 'auto' }
  // 卡住检测：很久没收到第一个 token -> 判定被前面的请求占住槽位，快速失败而不是干等
  const controller = new AbortController()
  activeAbort = controller
  let gotFirst = false
  let stuck = false
  const watchdog = setTimeout(() => { if (!gotFirst) { stuck = true; controller.abort() } }, 35000)
  const safety = setTimeout(() => { controller.abort() }, 300000)
  let res
  try {
    res = await fetch(ep + '/chat/completions', {
      method: 'POST', headers: srcHeaders,
      body: JSON.stringify(body), signal: controller.signal,
    })
  } catch (err) { clearTimeout(watchdog); clearTimeout(safety); return { error: '无法连接模型接口：' + String(err && err.message || err) } }
  if (!res.ok) {
    clearTimeout(watchdog); clearTimeout(safety)
    const t = await res.text().catch(() => '')
    return { error: '模型接口出错（' + res.status + '）：' + String(t).slice(0, 200) }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let text = ''
  let reasoning = ''
  const toolMap = new Map()
  const finalize = () => {
    const tcs = [...toolMap.values()].map((tc) => {
      let args = {}
      try { args = JSON.parse(tc.args || '{}') } catch (e) { args = {} }
      return { id: tc.id || ('call_' + tc.name), name: tc.name, args }
    }).filter((tc) => tc.name)
    return { text, reasoning, toolCalls: tcs }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) { clearTimeout(watchdog); clearTimeout(safety); return finalize() }
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data: ')) continue
        gotFirst = true
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') { clearTimeout(watchdog); clearTimeout(safety); return finalize() }
        try {
          const j = JSON.parse(payload)
          const d = (j.choices && j.choices[0] && j.choices[0].delta) || {}
          if (d.content) { text += d.content; if (onDelta) onDelta(text) }
          else if (d.reasoning_content) { reasoning += d.reasoning_content }
          if (d.tool_calls && Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              const i = tc.index || 0
              const cur = toolMap.get(i) || { id: '', name: '', args: '' }
              if (tc.id) cur.id = tc.id
              if (tc.function) {
                if (tc.function.name) cur.name += tc.function.name
                if (tc.function.arguments) cur.args += tc.function.arguments
              }
              toolMap.set(i, cur)
            }
          }
        } catch (e) { /* ignore */ }
      }
    }
  } catch (err) {
    clearTimeout(watchdog); clearTimeout(safety)
    if (stopRequested) return { error: '已停止' }
    if (stuck) return { error: '本地模型忙或卡住（可能被前面的请求占住了槽位），请到 LM Studio 点「停止」或「卸载→重新加载」模型后再试。' }
    return { error: 'LM Studio 请求超时或中断：' + String(err && err.message || err) }
  }
}

// ---------------------------------------------------------------------------
// Codex 模式本地分流：判断任务是否“力所能及”地交给本地模型
// ---------------------------------------------------------------------------
// 本地服务 origin：从 localEndpoint()（可能带 /v1 或 /api 后缀）推导出根地址，用于 Ollama /api/ps 等原生接口
function localOrigin() {
  return localEndpoint().replace(/\/v1\/?$/i, '').replace(/\/+$/, '')
}

// 读当前“已加载/运行中”的本地模型 id，适配多种本地来源（拿不到就返回空）。
// 优先用正在跑的模型，委派不用重新加载/换模型，既快又不会顶掉用户当前用的模型。
async function readLoadedLmModelId() {
  // 1) LM Studio：lms ps --json 拿 running 实例（它同一时刻只加载一个 LLM，最准确）
  const lms = lmsCliPath()
  if (lms) {
    try {
      const out = await new Promise((resolve, reject) => {
        execFile(lms, ['ps', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, stdout) => err ? reject(err) : resolve(stdout))
      })
      const arr = JSON.parse(out)
      const m = (Array.isArray(arr) ? arr : []).find((x) => x && (x.identifier || x.modelKey) && x.type === 'llm')
      if (m && (m.identifier || m.modelKey)) return String(m.identifier || m.modelKey)
    } catch (err) { /* lms 不可用则继续尝试其它来源 */ }
  }
  // 2) Ollama：GET /api/ps 拿当前加载到内存的模型（仅当明显是 Ollama 时才探测）
  const base = String(loadConfig().localBaseUrl || '')
  if (/(11434|\/api\/|ollama)/i.test(base)) {
    try {
      const res = await fetch(localOrigin() + '/api/ps', { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const data = await res.json()
        const arr = (data && Array.isArray(data.models)) ? data.models : []
        const m = (arr.find((x) => x && (x.name || x.model)) || {})
        const id = String(m.name || m.model || '').trim()
        if (id) return id
      }
    } catch (err) { /* 忽略，继续 */ }
  }
  // 3) 通用 OpenAI 兼容（llama.cpp / vLLM 等单模型服务）：/v1/models 若只有一个 LLM 模型则默认它已加载
  try {
    const res = await fetch(localEndpoint() + '/models', { signal: AbortSignal.timeout(4000) })
    if (res.ok) {
      const data = await res.json()
      const arr = (data && Array.isArray(data.data)) ? data.data : []
      const llms = arr.filter((m) => m && m.id && !/embed/i.test(String(m.id)))
      if (llms.length === 1) return String(llms[0].id)
    }
  } catch (err) { /* ignore */ }
  return ''
}

// 选择本地模型：优先用当前已加载的本地模型，否则挑一个可用模型（readLmModels 已过滤 embedding）
async function pickLocalModel() {
  try {
    const lms = await readLmModels()
    const ids = lms.map((m) => m.id)
    // 优先：用当前“已加载”的本地模型（LM Studio 同一时刻只有一个模型在显存里）。
    // 已加载的模型不需要重新加载/换模型，委派既快又不会顶掉你正在用的模型，避免爆显存。
    const loaded = await readLoadedLmModelId()
    if (loaded) return loaded
    // 回退：优先挑 id 不含 @ 的“干净”本地模型（避免挑到 LM Studio 占位/超大模型），否则取第一个
    return ids.find((id) => !/@/.test(id)) || ids[0] || ''
  } catch { return '' }
}

// 必须走 Codex 的硬性关键词：系统/网络/安装/进程/写操作/改代码等危险动作，即使开着 MCP 也不分流给本地；
// 简单的只读调用（查数据库、读文件、列目录等）不再硬拦，交给下面的工具感知分类器判断
const HARD_CODEX_RE = /(运行|执行|终端|命令行|安装|卸载|npm|pip|git|docker|ssh|部署|截图|屏幕|桌面|进程|杀掉|注册表|调试|编译|测试运行|运行脚本|执行脚本|快捷键|建表|数据库(导入|导出|备份|恢复|删除)|调用(接口|api)|打开(应用|程序|软件|excel|word|浏览器|网页|网站)|启动(应用|程序|软件|服务)|下载(文件|软件|视频|安装包)|爬虫|抓取(网页|数据)|联网(搜索|查询)|服务器.*(启动|停止|部署)|帮我(操作|执行|打开|关闭|启动|停止|运行|安装|卸载|下载)|修复.*(bug|报错|崩溃)|重构.*代码)/i

// 让本地模型自己判断：仅凭文本能否高质量完成（拿不准时兜底走 Codex）
async function lmClassify(msg) {
  const model = await pickLocalModel()
  if (!model) return false
  // 分类请求本身也要在上下文安全预算内，超了直接判给 Codex，避免把本地模型挤爆
  const sys = '你是一个任务路由器。判断标准：仅凭文本回复（不需要文件操作、终端命令、网页、数据库、截图、系统控制等任何工具）就能高质量完成的任务，判为本地可完成；需要工具或超出你能力范围的任务，判为需要云端智能体。'
  const usr = '用户请求：\n' + String(msg).slice(0, 2000) + '\n\n只输出一个 JSON 对象：{"local":true} 表示你（本地模型）能直接高质量完成，{"local":false} 表示需要云端智能体。不要输出任何其它内容。'
  const maxCtx = getLmMaxCtx(model) || 6144
  if (estimateTokens(sys) + estimateTokens(usr) + 200 > maxCtx - 900) return false
  try {
    const body = {
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: usr },
      ],
      stream: false,
      temperature: 0.5,
      max_tokens: 140,
      reasoning_effort: 'none',
    }
    const res = await fetch(localEndpoint() + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return false
    const j = await res.json()
    const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''
    return /"local"\s*:\s*true/i.test(text)
  } catch { return false }
}

// 收集当前能分流给本地模型的 MCP 工具名（受 chatMcp、服务器开关、只读/全权过滤、schema 预算约束）
async function localMcpToolNames() {
  try {
    const cfg = loadConfig()
    if (cfg.chatMcp !== true) return []
    const mc = await Promise.race([
      collectMcpTools(),
      new Promise((res) => setTimeout(() => res({ tools: [], byName: new Map() }), 8000)),
    ])
    const enabled = (mc.tools || []).filter((t) => t.on)
    const payload = buildLocalMcpTools(enabled)
    return payload.map((t) => t.function && t.function.name).filter(Boolean)
  } catch { return [] }
}

// 工具感知分类：开着 MCP 时，让本地模型判断“仅凭文本或一次简单的只读/查询类调用”能否高质量完成
async function lmClassifyWithTools(msg, toolNames) {
  const model = await pickLocalModel()
  if (!model) return false
  const names = (toolNames || []).slice(0, 20).join('、') || '（无）'
  const sys = '你是一个任务路由器。你手上可用的工具只有这些：' + names +
    '。判断标准：仅凭文本回复、或通过一次简单的只读/查询类工具调用（例如查一条数据、列目录、读一个小文件、查表结构）就能高质量完成的任务，判为本地可完成；' +
    '需要多步复杂推理、写/删/改数据或文件、联网、系统操作，或超出工具范围的任务，判为需要云端智能体。'
  const usr = '用户请求：\n' + String(msg).slice(0, 2000) +
    '\n\n只输出一个 JSON 对象：{"local":true} 表示你（本地模型）能直接或借助上面某个工具完成，{"local":false} 表示需要云端智能体。不要输出任何其它内容。'
  const maxCtx = getLmMaxCtx(model) || 6144
  if (estimateTokens(sys) + estimateTokens(usr) + 200 > maxCtx - 900) return false
  try {
    const body = {
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: usr },
      ],
      stream: false,
      temperature: 0.5,
      max_tokens: 140,
      reasoning_effort: 'none',
    }
    const res = await fetch(localEndpoint() + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return false
    const j = await res.json()
    const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''
    return /"local"\s*:\s*true/i.test(text)
  } catch { return false }
}

// 交给 Codex 跑时附带的本地委派提示：让它把纯文本子任务顺手交给本地模型
const LOCAL_DELEGATE_HINT = '[本地委派提示] 当前任务里，如果有一些子任务你判断仅凭文本就能高质量完成（例如：翻译、总结、解释概念、润色文案、简短问答、生成一段代码片段），请优先调用本地模型完成，以节省云端额度。调用方式：node local-qwen.mjs "子任务描述"（该脚本就在聊天工作目录，直接运行，不需要联网/额外权限）。注意：本地模型上下文较小（取决于 llama-server 的 --ctx-size），脚本会先估算输入并拒绝超长内容，所以只委派简短子任务。简单的文件写/删/改也可以委派：让本地模型直接生成新的文件内容、替换片段、删除方案或对应命令/代码，再由你执行；终端执行、网页、系统级安装卸载等复杂操作不要整段委派。如果本地模型调用失败或返回错误，也由你自己完成该子任务。'

// 本地委派助手脚本（Codex 用 `node local-qwen.mjs "问题"` 调用，参数沿用现有本地设置）
const LOCAL_QWEN_SCRIPT = `#!/usr/bin/env node
// 本地委派助手：供 Codex 模式下的智能体调用。
// 参数沿用现有本地设置：temperature 0.5 / max_tokens 2048 / 不思考（reasoning_effort: none）
// 委派前先估算输入 token，超出 llama-server 上下文安全预算会直接拒绝，避免把本地模型卡死。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
// 本地服务地址：优先读主配置 config.json 的 localBaseUrl，其次回退到 LM Studio 默认端口
let BASE_URL = 'http://127.0.0.1:1234/v1'
try {
  const cfgPath = path.join(process.env.APPDATA || '', 'deepseek-whale-pet', 'config.json')
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    const u = String(cfg.localBaseUrl || '').trim().replace(/\/+$/, '')
    if (u) BASE_URL = u
  }
} catch (err) { /* 忽略，回退默认 */ }
const API = BASE_URL + '/chat/completions'
function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of String(text)) {
    if (/[\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef]/.test(ch)) cjk++
    else if (!/\\s/.test(ch)) other++
  }
  return Math.ceil(cjk + other / 3.6)
}
function getMaxCtx() {
  // 读正在运行的 llama-server 的 --ctx-size（LM Studio 实际生效的上下文上限）
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'llama-server.exe' } | Select-Object -First 1 -ExpandProperty CommandLine"], { encoding: 'utf8', windowsHide: true })
    const m = /--ctx-size\\s+(\\d+)/.exec(out || '')
    if (m) return parseInt(m[1], 10)
  } catch (err) { /* ignore */ }
  return 32768
}
async function pickModel() {
  try {
    const r = await fetch(BASE_URL + '/models', { signal: AbortSignal.timeout(3000) })
    const j = await r.json()
    const ids = ((j && j.data) || []).map((x) => x.id).filter((id) => !/(embedding|embed|nomic-embed|bge-|gte-)/i.test(id))
    return ids[0] || ''
  } catch { return '' }
}
async function main() {
  const q = process.argv.slice(2).join(' ').trim()
  if (!q) { process.stdout.write('（没有收到问题）'); return }
  // 委派前 token 上限判断：超预算直接拒绝，避免本地模型卡死/崩溃
  const maxCtx = getMaxCtx()
  const budget = maxCtx - 900
  const used = estimateTokens(q) + 24
  if (used > budget) {
    process.stdout.write('（本地模型上下文不足：输入约 ' + used + ' tokens，上下文上限 ' + maxCtx + ' tokens，安全预算 ' + budget + '。任务内容过长，请自行完成或截断后再委派）')
    process.exit(1)
  }
  const model = await pickModel()
  if (!model) { process.stdout.write('（本地模型不可用：请确认已加载任意本地模型并启动服务）'); process.exit(1) }
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是一个本地小模型助手，请直接、简洁地回答用户问题，不要使用任何工具。' },
          { role: 'user', content: q },
        ],
        stream: false,
        temperature: 0.5,
        max_tokens: 2048,
        reasoning_effort: 'none',
      }),
      signal: AbortSignal.timeout(180000),
    })
    if (!res.ok) { process.stdout.write('（本地模型调用失败：HTTP ' + res.status + '）'); process.exit(1) }
    const j = await res.json()
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
    process.stdout.write(text || '（本地模型没有返回内容）')
  } catch (err) {
    process.stdout.write('（本地模型调用失败：' + (err && err.message || err) + '）')
    process.exit(1)
  }
}
main()
`

// 截取整个屏幕为 PNG，返回文件路径（供 codex -i 使用）
async function captureScreen(width) {
  try {
    const w = width || 512
    const h = Math.round(w * 0.5625)
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } })
    const source = sources[0]
    if (!source) return null
    // 强制压到目标宽度并转 JPEG，避免高清/高 DPI 屏返回超大 PNG 把机器拖死
    let img = source.thumbnail
    const sz = img.getSize()
    if (sz.width > w) {
      img = img.resize({ width: w, height: Math.round(sz.height * w / sz.width) })
    }
    const jpg = img.toJPEG(72)
    const dir = chatWorkspace()
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'screen-' + Date.now() + '.jpg')
    fs.writeFileSync(p, jpg)
    return p
  } catch (err) {
    console.error('[whale-pet] captureScreen failed:', err)
    return null
  }
}

// 把过大的图片文件压到最大宽度（减少视觉 token 与显存开销）
function downscaleImage(srcPath, maxW) {
  try {
    const img = nativeImage.createFromPath(srcPath)
    if (img.isEmpty()) return srcPath
    const size = img.getSize()
    if (!size.width || size.width <= maxW) return srcPath
    const nh = Math.round(size.height * maxW / size.width)
    const sized = img.resize({ width: maxW, height: nh })
    const isJpg = /\.(jpe?g)$/i.test(srcPath)
    const ext = isJpg ? 'jpg' : 'png'
    const dir = chatWorkspace()
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'img-' + Date.now() + '.' + ext)
    fs.writeFileSync(p, isJpg ? sized.toJPEG(75) : sized.toPNG())
    return p
  } catch (err) { return srcPath }
}

// 用 poppler 的 pdftoppm 把 PDF 第一页渲染成图片（供视觉模型读取），找找不到就返回 null
let pdftoppmBinCache = null
function findPdfToPpm() {
  if (pdftoppmBinCache) return pdftoppmBinCache
  const candidates = [
    'pdftoppm',
  ]
  for (const c of candidates) {
    try {
      if (c === 'pdftoppm') { spawn(c, ['-v'], { stdio: 'ignore', windowsHide: true }).on('exit', () => {}); pdftoppmBinCache = c; return c }
      if (fs.existsSync(c)) { pdftoppmBinCache = c; return c }
    } catch (e) { /* try next */ }
  }
  return null
}
function pdfToImage(pdfPath) {
  return new Promise((resolve) => {
    const bin = findPdfToPpm()
    if (!bin) return resolve(null)
    const dir = chatWorkspace()
    try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { /* ignore */ }
    const out = path.join(dir, 'pdfpage-' + Date.now())
    const cp = spawn(bin, ['-jpeg', '-r', '100', '-f', '1', '-l', '1', pdfPath, out], { windowsHide: true })
    let timer = setTimeout(() => { try { cp.kill() } catch (e) {} resolve(null) }, 30000)
    cp.on('error', () => { clearTimeout(timer); resolve(null) })
    cp.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve(null)
      try {
        const f = fs.readdirSync(dir).filter((x) => /^pdfpage-\d+-1\.(jpe?g|png)$/i.test(x)).sort().pop()
        if (!f) return resolve(null)
        resolve(downscaleImage(path.join(dir, f), 512))
      } catch (e) { resolve(null) }
    })
  })
}

// 实时屏幕预览：持续截图推送到对话窗口
let screenTimer = null
function startLivePreview() {
  if (screenTimer) return
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const jpg = await captureScreen(448)
      if (!jpg) return
      const buf = fs.readFileSync(jpg)
      if (chatWin && !chatWin.isDestroyed()) {
        chatWin.webContents.send('chat:screen', 'data:image/jpeg;base64,' + buf.toString('base64'))
      }
      try { fs.unlinkSync(jpg) } catch (err) { /* ignore */ }
    } catch (err) { /* ignore */ } finally { busy = false }
  }
  tick()
  screenTimer = setInterval(tick, 3000)
}
function stopLivePreview() {
  if (screenTimer) { clearInterval(screenTimer); screenTimer = null }
}

let codexBinCache = null
function getCodexBin() {
  if (codexBinCache) return codexBinCache
  const maybe = (loadConfig().chatCodexPath || '').trim()
  if (maybe) {
    codexBinCache = maybe
    return maybe
  }
  try {
    const out = execFileSync('where', ['codex'], { encoding: 'utf8' }).toString().trim().split(/\r?\n/)[0]
    if (out && fs.existsSync(out)) { codexBinCache = out; return out }
  } catch (err) { /* fall through */ }
  // 自动扫描 OpenAI Codex 安装目录（版本目录会更新，取最新的 codex.exe）
  try {
    const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin')
    if (fs.existsSync(base)) {
      const dirs = fs.readdirSync(base).filter((d) => /^\d+/i.test(d)).sort().reverse()
      for (const d of dirs) {
        const p = path.join(base, d, 'codex.exe')
        if (fs.existsSync(p)) { codexBinCache = p; return p }
      }
    }
  } catch (err) { /* fall through */ }
  codexBinCache = 'codex'
  return codexBinCache
}

function openChat() {
  if (chatWin && !chatWin.isDestroyed()) { chatWin.focus(); return }
  if (!petWin || petWin.isDestroyed()) return
  const pos = chatBubblePosition()
  chatOn = true
  chatWin = new BrowserWindow({
    width: CHAT_WIN_W,
    height: CHAT_H,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  chatWin.setAlwaysOnTop(true, 'screen-saver')
  chatWin.loadFile(path.join(__dirname, 'renderer', 'chatwindow.html'))
  chatWin.once('ready-to-show', () => {
    chatWin.show()
    chatWin.moveTop()
    chatWin.focus()
    if (loadConfig().lookScreen === true) startLivePreview()
  })
  chatWin.on('closed', () => {
    chatWin = null
    chatOn = false
    stopLivePreview()
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:chat-close')
    // 恢复点击穿透（若开启过）
    if (petWin && !petWin.isDestroyed() && loadConfig().clickThrough === true) {
      petWin.setIgnoreMouseEvents(true, { forward: true })
    }
  })
  // 聊天时隐藏余额气泡
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send('pet:chat-open')
    // 聊天时临时取消桌宠的鼠标穿透，避免文字无法输入
    if (loadConfig().clickThrough === true) petWin.setIgnoreMouseEvents(false)
  }
}

function closeChat() {
  if (chatWin && !chatWin.isDestroyed()) chatWin.close()
}

// 快捷键：再按一次关闭对话，按开/关切换
function toggleChat() {
  if (chatWin && !chatWin.isDestroyed()) closeChat()
  else openChat()
}

const CHAT_W = 320          // 对话框主体实际宽度
const CHAT_SIDE = 44        // 左侧给 MCP 工具条悬浮的空隙（toolstrip 悬浮在 card 外侧）
const CHAT_WIN_W = CHAT_W + CHAT_SIDE  // 聊天窗口总宽 = 320 + 44 = 364
const CHAT_H = 440
const CHAT_GAP = 14
function chatBubblePosition() {
  const wa = screen.getPrimaryDisplay().workArea
  const b = petWin.getBounds()
  const size = b.width
  const bx = Math.round(size * 0.44346)
  const by = Math.round(size * 0.255)
  const effW = CHAT_WIN_W + 8
  const effH = CHAT_H + 8
  // 余额气泡（画在鲸鱼图上的椭圆）的大致中心
  const bubbleX = b.x + bx
  const bubbleY = b.y + by
  // 对话框水平中心对准气泡
  // 对话框的 card 靠右（左侧留 toolstrip 空隙），让 card 中心对准气泡
  const cardCenter = CHAT_SIDE + Math.round(CHAT_W / 2)
  const cx = Math.max(wa.x, Math.min(bubbleX - cardCenter, wa.x + wa.width - effW))
  // 1) 默认：让对话框压住余额气泡并向上延伸（贴近头顶）
  let y = bubbleY + 24 - CHAT_H
  if (y >= wa.y) return { x: cx, y, side: 'top' }
  // 2) 上方放不下：向下压住气泡
  y = bubbleY - 24
  if (y + effH <= wa.y + wa.height) return { x: cx, y, side: 'bottom' }
  // 3) 侧边（兜底）
  const spaceRight = wa.x + wa.width - (b.x + size)
  const spaceLeft = b.x - wa.x
  const side = spaceRight >= spaceLeft ? 'right' : 'left'
  let x = side === 'right' ? b.x + size + CHAT_GAP : b.x - CHAT_GAP - CHAT_WIN_W
  let y2 = bubbleY - Math.round(CHAT_H / 2)
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - effW))
  y2 = Math.max(wa.y, Math.min(y2, wa.y + wa.height - effH))
  return { x, y: y2, side }
}

// 让桌宠的 MCP 开关对云端 codex 也生效：桌宠已开启的工具，云端不再重复检查
// （把 codex config.toml 里与桌宠已开启工具相同命令的 mcp_servers 通过 -c 禁掉；未开启/没有的保留 codex 自己的）
function codexMcpOverrides() {
  const cfg = loadConfig()
  if (cfg.chatMcp !== true) return []
  const onServers = (cfg.mcps || []).filter((d) => !cfg.mcpServersOn || cfg.mcpServersOn[d.id] !== false)
  if (!onServers.length) return []
  const codexCfgPath = path.join(os.homedir(), '.codex', 'config.toml')
  let codexServers = []
  try {
    const txt = fs.readFileSync(codexCfgPath, 'utf8')
    const re = /\[mcp_servers\.([^\]]+)\]\s*([\s\S]*?)(?=\n\[|\n$|$)/g
    let m
    while ((m = re.exec(txt))) {
      const block = m[2]
      const cmd = (block.match(/command\s*=\s*["']([^"']+)["']/) || [])[1] || ''
      const am = block.match(/args\s*=\s*\[([^\]]*)\]/)
      const args = am ? am[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).join(' ') : ''
      codexServers.push({ name: m[1].trim(), sig: (cmd + ' ' + args).toLowerCase().replace(/\s+/g, ' ').trim() })
    }
  } catch (err) { return [] }
  const out = []
  for (const s of onServers) {
    const sSig = (String(s.command || '') + ' ' + (s.args || []).join(' ')).toLowerCase().replace(/\s+/g, ' ').trim()
    if (!sSig) continue
    for (const cs of codexServers) {
      if (cs.sig && (cs.sig.includes(sSig) || sSig.includes(cs.sig))) {
        out.push('-c', 'mcp_servers.' + cs.name + '.enabled=false')
      }
    }
  }
  return out
}

// 通用 OpenAI 兼容 LLM（可选来源）：直接调用配置的 base_url + key + model，流式返回
// 云端 API 来源的系统人设：与本地模型 / Codex 的 AGENTS.md 保持一致的“大肥鱼 + 呆萌”
const LLM_SYSTEM_PROMPT = '你是桌宠「大肥鱼」，性格温和、友好、乐于助人。回答尽量直接、清晰、口语化，**少用表情符号/emoji**；面对问题要认真、准确、完整地回答，不要因为显得“萌/憨”而敷衍或简化。当系统向你提供了工具（例如生成 Excel/Word/PDF/PPT、读写文件、生图）时，你要主动调用合适工具来完成任务，而不是说自己不会；工具会自动处理文件格式，你只需提供正确的参数。'
async function runLlm(conv, model, imagePath, onDelta, onDone, onStatus) {
  const cfg = loadConfig()
  const baseUrl = String(cfg.llmBaseUrl || '').trim().replace(/\/+$/, '')
  if (!baseUrl) { onDone({ error: '未配置 LLM 接口地址（llmBaseUrl）' }); return }
  const apiKey = String(cfg.llmApiKey || '')
  const useModel = String(cfg.llmModel || model || '').trim()
  if (!useModel) { onDone({ error: '未配置 LLM 模型名（llmModel）' }); return }
  const messages = [{ role: 'system', content: LLM_SYSTEM_PROMPT }].concat((conv.messages || []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })))
  if (!(conv.messages || []).length) { onDone({ error: '没有可发送的内容' }); return }
  const isVision = resolveVision(useModel)
  if (imagePath && isVision) {
    try {
      const imgB64 = fs.readFileSync(imagePath).toString('base64')
      const ext = (String(imagePath).match(/\.([A-Za-z0-9]+)$/) || [null, 'png'])[1].toLowerCase()
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png'
      const last = messages[messages.length - 1]
      if (last && last.role === 'user') last.content = [{ type: 'text', text: String(last.content) }, { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + imgB64 } }]
    } catch (err) { /* ignore */ }
  } else if (imagePath) {
    const last = messages[messages.length - 1]
    if (last && last.role === 'user') {
      last.content = String(last.content || '') + '\n（用户附带了一张图片，但当前模型不支持看图。若想读图请切换到带视觉能力的模型，如 qwen3vl / gpt-4o 等）'
    }
  }
  if (onStatus) onStatus('大肥鱼：正在思考…')
  // 收集已开启的 MCP 工具（与本地模式共用同一套安全守卫与白名单）
  let toolsPayload = null
  let byName = new Map()
  if (loadConfig().chatMcp === true) {
    try {
      const mc = await Promise.race([
        collectMcpTools(),
        new Promise((res) => setTimeout(() => res({ tools: [], byName: new Map() }), 8000)),
      ])
      const enabled = (mc.tools || []).filter((t) => t.on)
      if (enabled.length) {
        toolsPayload = buildLocalMcpTools(enabled)
        byName = mc.byName
      }
    } catch (err) { /* 工具不可用则正常纯文本 */ }
  }
  const opts = { baseUrl, apiKey, source: 'llm' }
  const MAX_ROUNDS = 6
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const out = await lmStreamChat(messages, useModel, toolsPayload, onDelta, opts)
    if (out.error) { onDone({ error: out.error }); return }
    const tcs = out.toolCalls || []
    if (tcs.length) {
      if (onStatus) onStatus('大肥鱼：正在调用工具…')
      messages.push({
        role: 'assistant',
        content: out.text || '',
        tool_calls: tcs.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } })),
      })
      for (const tc of tcs) {
        let result = ''
        const meta = byName.get(tc.name)
        if (meta) {
          try {
            if (meta.serverId === '__builtin__') {
              // 内置工具（生图/Excel/文件/文档）：不依赖外部 mcps 服务器，直接执行
              const r = await execMcpToolCall(meta, null, tc.args)
              result = (r && r.text) || ''
            } else {
              const def = (loadConfig().mcps || []).find((d) => d.id === meta.serverId)
              if (def) {
                const r = await execMcpToolCall(meta, def, tc.args)
                result = (r && r.text) || ''
              } else result = '工具服务器未配置'
            }
          } catch (err) { result = '工具调用失败：' + String(err && err.message || err) }
        } else { result = '未知工具' }
        if (round === 0 && onDelta) onDelta('[正在调用工具 ' + tc.name.split('_').pop() + '…]')
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
      }
      continue
    }
    if (out.text) { onDelta && onDelta(out.text); onDone({ text: out.text }) }
    else if (out.reasoning) { onDelta && onDelta(out.reasoning); onDone({ text: out.reasoning }) }
    else onDone({ error: '模型接口没有返回内容' })
    return
  }
  onDone({ error: '工具调用轮次过多，已停止' })
}

// 调用 codex exec --json，实时把助手回复转发给聊天窗口
function runCodex(conv, message, model, imagePath, onDelta, onDone, onStatus) {
  const bin = getCodexBin()
  const cd = chatWorkspace()
  try { fs.mkdirSync(cd, { recursive: true }) } catch (err) { /* ignore */ }
  const modelOpts = (model && String(model).trim()) ? ['-m', String(model).trim()] : []
  const imageOpts = imagePath ? ['-i', imagePath] : []
  let args
  if (conv.threadId) {
    // resume 只接受 --json/--all/--skip-git-repo-check 等；续聊沿用会话原有沙箱与目录
    args = ['exec', 'resume', '--json', '--all', '--skip-git-repo-check', ...modelOpts, ...imageOpts, conv.threadId, '-']
  } else {
    args = ['exec', '--json', '--cd', cd, '--sandbox', 'danger-full-access', '--skip-git-repo-check', '--color', 'never', ...modelOpts, ...imageOpts, ...codexMcpOverrides(), '-']
  }
  let child
  try {
    child = spawn(bin, args, { cwd: cd })
  } catch (err) {
    onDone({ error: String(err && err.message || err) })
    return
  }
  activeChild = child
  if (onStatus) onStatus('大肥鱼：正在思考…')
  // 把消息写到标准输入（比命令行参数更稳，避免中文/编码问题）
  try {
    child.stdin.write(message + '\n')
    child.stdin.end()
  } catch (err) { /* ignore */ }
  let threadId = conv.threadId || null
  let text = ''
  let buf = ''
  let stderr = ''
  let finished = false
  let timer = null

  const handleEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return
    if (ev.type === 'thread.started' && ev.thread_id) threadId = ev.thread_id
    const item = ev.item
    if (item && item.type === 'agent_message') {
      if (ev.type === 'item.completed' && item.text != null) text = item.text
      else if (ev.type === 'item.updated' && item.text != null) text = item.text
      else if (ev.type === 'item.started' && item.text != null) text = item.text
      if (text) onDelta && onDelta(text)
    } else if (item && item.type === 'reasoning') {
      if (onStatus) onStatus('大肥鱼：正在思考…')
    } else if (item && item.type && /function|tool|command|bash|exec|call/i.test(item.type)) {
      if (onStatus) onStatus('大肥鱼：正在调用工具…')
    }
  }
  const finish = () => {
    if (finished) return
    finished = true
    if (activeChild === child) activeChild = null
    if (timer) clearTimeout(timer)
    if (stopRequested) { onDone({ threadId, error: '已停止' }); return }
    if (text) {
      onDone({ threadId, text })
    } else if (stderr.trim()) {
      onDone({ threadId, error: String(stderr).slice(-900) })
    } else {
      onDone({ threadId, error: 'codex 没有返回内容' })
    }
  }
  // 5 分钟超时保护：避免一直“正在输入”（Codex 智能体多步工具任务可能较久）
  timer = setTimeout(() => {
    if (finished) return
    finished = true
    try { child.kill('SIGKILL') } catch (err) { /* ignore */ }
    onDone({ threadId, error: '回复超时，请重试' })
  }, 300000)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      handleEvent(ev)
    }
  })
  child.stdout.on('end', () => {
    if (buf.trim()) { try { handleEvent(JSON.parse(buf.trim())) } catch { /* ignore */ } }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { stderr += d.toString() })
  child.on('error', (err) => { if (!finished) { finished = true; if (timer) clearTimeout(timer); onDone({ threadId, error: String(err.message || err) }) } })
  child.on('close', () => finish())
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('pet:get-balance', () => fetchBalance())
ipcMain.handle('pet:get-screen', () => {
  const d = screen.getPrimaryDisplay()
  return { workArea: d.workArea, bounds: d.bounds }
})
ipcMain.handle('pet:get-position', () => {
  if (!petWin || petWin.isDestroyed()) return { x: 0, y: 0 }
  const [x, y] = petWin.getPosition()
  return { x, y }
})
ipcMain.handle('pet:set-position', (_e, { x, y }) => {
  if (!petWin || petWin.isDestroyed()) return { x: 0, y: 0 }
  // 用 setBounds 显式固定宽高再移动：Windows 显示缩放非 100% 时，setPosition 拖动无边框
  // 窗口会按移动方向被拉伸放大；这里锁定为正方形，避免拖动时变形（修复「拖动放大」）
  const size = petSize(cfg.scale)
  const nx = Math.round(x)
  const ny = Math.round(y)
  petWin.setBounds({ x: nx, y: ny, width: size, height: size })
  // 拖动鲸鱼时让对话气泡跟着一起移动（重新计算放在有空间的一侧并夹到屏幕内）
  if (chatWin && !chatWin.isDestroyed()) {
    const pos = chatBubblePosition()
    chatWin.setBounds({ x: pos.x, y: pos.y, width: CHAT_WIN_W, height: CHAT_H })
  }
  schedulePosSave()
  return { x: nx, y: ny }
})
ipcMain.handle('pet:get-size', () => {
  const scale = loadConfig().scale
  return { size: petSize(scale), scale, minSize: MIN_SIZE, maxSize: MAX_SIZE }
})
ipcMain.handle('pet:set-scale', (_e, { scale }) => {
  const next = Math.round(clamp(scale, MIN_SCALE, MAX_SCALE) * 10) / 10
  cfg = saveConfig({ scale: next })
  if (petWin && !petWin.isDestroyed()) {
    const b = petWin.getBounds()
    const size = petSize(next)
    petWin.setBounds({ x: b.x, y: b.y, width: size, height: size })
  }
  return { scale: next, size: petSize(next) }
})
ipcMain.handle('pet:get-config', () => {
  const c = loadConfig()
  return {
    hasKey: !!c.apiKey.trim(), scale: c.scale,
    snap: c.snap !== false, label: c.label || 'DeepSeek 余额', refreshSec: c.refreshSec,
    lowBalanceAlert: !!c.lowBalanceAlert, lowThreshold: c.lowThreshold,
    idleTransparency: c.idleTransparency !== false, idleSec: c.idleSec,
    trackStats: c.trackStats !== false, mood: c.mood !== false, bounceAnim: c.bounceAnim !== false,
    sound: c.sound !== false, quotesEnabled: !!c.quotesEnabled, quotesText: c.quotesText || '',
    customImage: !!c.customImage, hotkey: c.hotkey !== false, trayIcon: c.trayIcon !== false,
    autoStart: !!c.autoStart, displayMode: c.displayMode || 'all', alwaysOnTop: c.alwaysOnTop !== false, showTime: c.showTime !== false,
    clickThrough: c.clickThrough === true, clickThroughOpacity: (typeof c.clickThroughOpacity === 'number' ? c.clickThroughOpacity : 0.6),
    chatHotkey: c.chatHotkey || 'Alt+Q',
  }
})
ipcMain.handle('pet:get-full-config', () => {
  const c = loadConfig()
  return {
    apiKey: c.apiKey, balanceUrl: c.balanceUrl || '', snap: c.snap !== false,
    label: c.label || 'DeepSeek 余额', refreshSec: c.refreshSec, scale: c.scale,
    lowBalanceAlert: !!c.lowBalanceAlert, lowThreshold: c.lowThreshold,
    idleTransparency: c.idleTransparency !== false, idleSec: c.idleSec,
    trackStats: c.trackStats !== false, mood: c.mood !== false, bounceAnim: c.bounceAnim !== false,
    sound: c.sound !== false, quotesEnabled: !!c.quotesEnabled, quotesText: c.quotesText || '',
    customImage: !!c.customImage, hotkey: c.hotkey !== false, trayIcon: c.trayIcon !== false,
    autoStart: !!c.autoStart, displayMode: c.displayMode || 'all', alwaysOnTop: c.alwaysOnTop !== false, showTime: c.showTime !== false,
    clickThrough: c.clickThrough === true, clickThroughOpacity: (typeof c.clickThroughOpacity === 'number' ? c.clickThroughOpacity : 0.6),
    chatProvider: c.chatProvider || 'codex', llmBaseUrl: c.llmBaseUrl || '', llmApiKey: c.llmApiKey || '',
    llmModel: c.llmModel || '', localBaseUrl: c.localBaseUrl || '',
  }
})
ipcMain.handle('pet:save-settings', (_e, settings) => {
  const s = settings || {}
  const apiKey = String(s.apiKey || '').trim()
  const balanceUrl = String(s.balanceUrl || '').trim()
  const label = String(s.label || '').trim() || 'DeepSeek 余额'
  let refreshSec = Number(s.refreshSec)
  if (!Number.isFinite(refreshSec)) refreshSec = 30
  refreshSec = Math.round(clamp(refreshSec, 0, 3600))
  let lowThreshold = Number(s.lowThreshold)
  if (!Number.isFinite(lowThreshold)) lowThreshold = 5
  lowThreshold = clamp(lowThreshold, 0, 100000)
  // 缺失的字段保留当前已保存的值，避免部分保存把设置重置回默认
  const cur = loadConfig()
  const bool = function (v, dft) { return typeof v === 'boolean' ? v : dft }
  const patch = {
    apiKey, balanceUrl,
    snap: bool(s.snap, cur.snap !== false),
    label,
    refreshSec,
    scale: cfg.scale,
    lowBalanceAlert: bool(s.lowBalanceAlert, !!cur.lowBalanceAlert),
    lowThreshold,
    idleTransparency: bool(s.idleTransparency, cur.idleTransparency !== false),
    idleSec: clamp(Number(s.idleSec) || cur.idleSec || 5, 1, 300),
    trackStats: bool(s.trackStats, cur.trackStats !== false),
    mood: bool(s.mood, cur.mood !== false),
    bounceAnim: bool(s.bounceAnim, cur.bounceAnim !== false),
    sound: bool(s.sound, cur.sound !== false),
    quotesEnabled: bool(s.quotesEnabled, !!cur.quotesEnabled),
    quotesText: String(s.quotesText || '').trim(),
    customImage: bool(s.customImage, !!cur.customImage),
    hotkey: bool(s.hotkey, cur.hotkey !== false),
    chatHotkey: s.chatHotkey === undefined ? (cur.chatHotkey || 'Alt+Q') : (String(s.chatHotkey).trim() || 'Alt+Q'),
    trayIcon: bool(s.trayIcon, cur.trayIcon !== false),
    autoStart: bool(s.autoStart, !!cur.autoStart),
    displayMode: (s.displayMode === 'taskbar' || s.displayMode === 'tray' || s.displayMode === 'hidden') ? s.displayMode : 'all',
    alwaysOnTop: bool(s.alwaysOnTop, cur.alwaysOnTop !== false),
    showTime: bool(s.showTime, cur.showTime !== false),
    clickThrough: bool(s.clickThrough, !!cur.clickThrough),
    clickThroughOpacity: clamp(Number(s.clickThroughOpacity) || cur.clickThroughOpacity || 0.6, 0.2, 1),
    chatProvider: (s.chatProvider === 'lmstudio' || s.chatProvider === 'llm') ? s.chatProvider : 'codex',
    llmBaseUrl: String(s.llmBaseUrl || '').trim(),
    llmApiKey: String(s.llmApiKey || '').trim(),
    llmModel: String(s.llmModel || '').trim(),
    localBaseUrl: String(s.localBaseUrl || '').trim(),
  }
  // 只应用调用方显式提供的字段，避免“部分保存”把未传的配置（如 apiKey）重置为默认
  for (const k of Object.keys(patch)) if (!(k in s)) delete patch[k]
  const oldMode = cur.displayMode || 'all'
  const oldSkip = (oldMode === 'tray' || oldMode === 'hidden')
  const newSkip = (patch.displayMode === 'tray' || patch.displayMode === 'hidden')
  cfg = saveConfig(patch)
  if (oldSkip !== newSkip) {
    // 任务栏显隐状态变化 -> 重建窗口以应用创建期 skipTaskbar
    recreatePetWindow()
  } else {
    applyDisplayMode(cfg.displayMode)
  }
  updateHotkey(cfg.hotkey)
  updateAutoStart(cfg.autoStart)
  applyClickThrough()
  refreshTrayMenu()
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send('pet:refresh')
    petWin.webContents.send('pet:config-updated')
  }
  return { ok: true, hasKey: !!apiKey }
})
ipcMain.handle('pet:save-key', (_e, { apiKey }) => {
  cfg = saveConfig({ apiKey: String(apiKey || '').trim() })
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:refresh')
  return { ok: true, hasKey: !!cfg.apiKey.trim() }
})
ipcMain.handle('pet:get-stats', () => {
  loadStats()
  return { today: stats.today, todayUsed: stats.todayUsed, lastBalance: stats.lastBalance }
})
ipcMain.handle('pet:set-idle', (_e, { idle }) => {
  petIdle = !!idle
  applyPetOpacity()
  return { idle: petIdle }
})
ipcMain.handle('pet:set-click-through', () => toggleClickThrough())
ipcMain.handle('pet:get-image-url', () => {
  const c = loadConfig()
  if (c.customImage && fs.existsSync(customImagePath())) {
    return { url: 'file://' + customImagePath().replace(/\\/g, '/') }
  }
  return { url: '' }
})
ipcMain.handle('pet:choose-image', () => chooseCustomImage())
ipcMain.handle('pet:open-settings', () => openSettings())
ipcMain.handle('pet:open-chat', () => openChat())
ipcMain.handle('pet:close-chat', () => closeChat())
ipcMain.handle('pet:file-exists', (_e, { p }) => {
  try { return { exists: typeof p === 'string' && p.length > 0 && fs.existsSync(p) } } catch (err) { return { exists: false } }
})
ipcMain.handle('pet:pick-file', async () => {
  try {
    const r = await dialog.showOpenDialog(chatWin || petWin, { title: '选择要附带的文件', properties: ['openFile'] })
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false }
    return { ok: true, path: r.filePaths[0] }
  } catch (err) { return { ok: false, error: String(err && err.message || err) } }
})

// ---------------------------------------------------------------------------
// 对话 IPC
// ---------------------------------------------------------------------------
ipcMain.handle('chat:list', () => {
  const convs = loadConvs().map((c) => ({
    id: c.id,
    title: c.title || '',
    archived: !!c.archived,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    threadId: !!c.threadId,
  }))
  return { conversations: convs }
})
ipcMain.handle('chat:models', () => ({ models: readChatModels() }))
ipcMain.handle('chat:lm-models', () => readLmModels().then((models) => ({ models })))
ipcMain.handle('chat:get-provider', () => ({ provider: loadConfig().chatProvider === 'lmstudio' ? 'lmstudio' : (loadConfig().chatProvider === 'llm' ? 'llm' : 'codex') }))
ipcMain.handle('chat:set-provider', (_e, { provider }) => {
  cfg = saveConfig({ chatProvider: provider === 'llm' ? 'llm' : (provider === 'lmstudio' ? 'lmstudio' : 'codex') })
  return { ok: true, provider: loadConfig().chatProvider === 'lmstudio' ? 'lmstudio' : (loadConfig().chatProvider === 'llm' ? 'llm' : 'codex') }
})
ipcMain.handle('chat:get-model', () => ({ model: loadConfig().chatModel || '' }))
ipcMain.handle('chat:get-llm', () => ({ baseUrl: loadConfig().llmBaseUrl || '', model: loadConfig().llmModel || '' }))
ipcMain.handle('chat:set-model', (_e, { model }) => {
  cfg = saveConfig({ chatModel: String(model || '').trim() })
  return { ok: true, model: loadConfig().chatModel }
})
ipcMain.handle('chat:get-look', () => ({ look: loadConfig().lookScreen === true }))
ipcMain.handle('chat:set-look', (_e, { look }) => {
  cfg = saveConfig({ lookScreen: !!look })
  if (look && chatWin && !chatWin.isDestroyed()) startLivePreview()
  else if (!look) stopLivePreview()
  return { ok: true, look: loadConfig().lookScreen === true }
})
ipcMain.handle('chat:get-vision', () => {
  const model = loadConfig().chatModel || ''
  return { on: resolveVision(model), model }
})
ipcMain.handle('chat:set-vision', (_e, { on }) => {
  cfg = saveConfig({ chatForceVision: !!on })
  return { ok: true, on: resolveVision(loadConfig().chatModel || '') }
})
ipcMain.handle('chat:get-thinking', () => ({ on: loadConfig().chatThinking !== false }))
ipcMain.handle('chat:set-thinking', (_e, { on }) => {
  cfg = saveConfig({ chatThinking: !!on })
  return { ok: true, on: loadConfig().chatThinking !== false }
})
ipcMain.handle('chat:get-local-route', () => ({ on: loadConfig().chatLocalRoute === true }))
ipcMain.handle('chat:set-local-route', (_e, { on }) => {
  cfg = saveConfig({ chatLocalRoute: !!on })
  return { ok: true, on: loadConfig().chatLocalRoute === true }
})

// ---- 本地模型状态检测（文本 49674 / 生图 8188 / 显存） ----
function portOpen(port, timeout) {
  return new Promise((resolve) => {
    const t = timeout || 800
    let done = false
    const s = net.connect({ host: '127.0.0.1', port })
    const fin = (v) => { if (done) return; done = true; try { s.destroy() } catch (e) {}; resolve(v) }
    s.setTimeout(t, () => fin(false))
    s.once('connect', () => fin(true))
    s.once('error', () => fin(false))
    s.once('timeout', () => fin(false))
  })
}
let gpuVramCache = null
let gpuVramAt = 0
async function readGpuVram() {
  const now = Date.now()
  if (gpuVramCache && now - gpuVramAt < 5000) return gpuVramCache
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true }).trim()
    const m = /([\d.]+),\s*([\d.]+)/.exec(out)
    gpuVramCache = m ? { used: Math.round(Number(m[1])), total: Math.round(Number(m[2])) } : null
  } catch (e) { gpuVramCache = null }
  gpuVramAt = now
  return gpuVramCache
}
async function detectTextModel() {
  // 优先：LM Studio 网关 1234 已加载 Qwen 模型即视为在线（后端端口是动态的）
  try {
    const lms = await readLmModels()
    if (Array.isArray(lms) && lms.length) return true
  } catch (err) { /* ignore */ }
  // 兜底：直接启动的 llama-server，从命令行读实际 --port
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'llama-server.exe' } | Select-Object -ExpandProperty CommandLine"], { encoding: 'utf8', windowsHide: true })
    const ports = [...String(out || '').matchAll(/--port\s+(\d+)/g)].map((m) => Number(m[1]))
    for (const p of ports) { if (p && await portOpen(p)) return true }
  } catch (err) { /* ignore */ }
  return false
}
ipcMain.handle('chat:get-gpu-status', async () => {
  const [text, img] = await Promise.all([detectTextModel(), portOpen(8188)])
  const vram = await readGpuVram()
  return { text, img, vram, both: !!(text && img), at: Date.now() }
})
ipcMain.handle('chat:get-mcp', async () => {
  const cfg = loadConfig()
  return {
    on: cfg.chatMcp === true,
    // 纯重复服务器（工具全被内置覆盖，如 qwen-files）不再显示开关
    servers: (cfg.mcps || []).filter((def) => !isBuiltinDupServer(def)).map((def) => ({ id: def.id, name: def.name, on: !cfg.mcpServersOn || cfg.mcpServersOn[def.id] !== false })),
  }
})
ipcMain.handle('chat:set-mcp', (_e, { on }) => {
  mcpToolCache = null; mcpToolAt = 0
  cfg = saveConfig({ chatMcp: !!on })
  return { ok: true, on: !!on }
})
ipcMain.handle('chat:set-mcp-server', (_e, { id, on }) => {
  mcpToolCache = null; mcpToolAt = 0
  const m = { ...(loadConfig().mcpServersOn || {}) }
  m[id] = !!on
  cfg = saveConfig({ mcpServersOn: m })
  return { ok: true }
})
ipcMain.handle('chat:ctx-info', (_e, { id }) => {
  const conv = loadConvs().find((c) => c.id === id)
  const max = getLmMaxCtx(id || loadConfig().chatModel || '')
  const used = conv ? convTokens(conv) : 0
  return { max, used, remaining: Math.max(0, max - used) }
})
ipcMain.handle('chat:get', (_e, { id }) => {
  const conv = loadConvs().find((c) => c.id === id) || null
  return { conversation: conv }
})
ipcMain.handle('chat:new', () => {
  const conv = {
    id: newConvId(),
    title: '',
    threadId: null,
    archived: false,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const arr = loadConvs()
  arr.unshift(conv)
  saveConvs(arr)
  return { conversation: conv }
})
ipcMain.handle('chat:archive', (_e, { id, archived }) => {
  const arr = loadConvs()
  const conv = arr.find((c) => c.id === id)
  if (conv) { conv.archived = !!archived; touchConv(conv); saveConvs(arr) }
  return { ok: true }
})
ipcMain.handle('chat:del', (_e, { id }) => {
  saveConvs(loadConvs().filter((c) => c.id !== id))
  return { ok: true }
})
ipcMain.handle('chat:stop', () => {
  stopRequested = true
  if (activeAbort) { try { activeAbort.abort() } catch (err) { /* ignore */ } }
  if (activeChild) { try { activeChild.kill('SIGKILL') } catch (err) { /* ignore */ } }
  return { ok: true }
})
ipcMain.handle('chat:grab-clipboard', () => {
  try {
    const img = clipboard.readImage()
    if (img.isEmpty()) return { ok: false, error: '剪贴板里没有图片' }
    const dir = chatWorkspace()
    fs.mkdirSync(dir, { recursive: true })
    // 压到最大 512 宽并转 JPEG，防爆显存/卡死
    let out = img
    const sz = img.getSize()
    if (sz.width > 512) out = img.resize({ width: 512, height: Math.round(sz.height * 512 / sz.width) })
    const p = path.join(dir, 'clip-' + Date.now() + '.jpg')
    fs.writeFileSync(p, out.toJPEG(75))
    return { ok: true, path: p }
  } catch (err) { return { ok: false, error: String(err && err.message || err) } }
})
ipcMain.handle('chat:send', async (_e, { id, message, look, attach }) => {
  stopRequested = false
  const arr = loadConvs()
  const conv = arr.find((c) => c.id === id)
  if (!conv) return { ok: false, error: '对话不存在' }
  const msg = String(message || '').trim()
  if (!msg) return { ok: false, error: '消息为空' }
  let effectiveMsg = msg
  let localMsg = null
  let imagePath = null
  let notice = ''
  const prov = loadConfig().chatProvider === 'lmstudio' ? 'lmstudio' : 'codex'
  if (attach) {
    const low = String(attach).toLowerCase()
    if (/\.(png|jpe?g|webp|gif|bmp)$/.test(low)) {
      imagePath = attach
    } else {
      const content = readfile.readFileText(attach)
      const isPdf = low.endsWith('.pdf')
      const enough = content && (!isPdf || content.trim().length >= 100)
      if (enough) {
        // 本地模型上下文有限，避免把整篇塞进去导致卡死/崩溃；云端可容纳更多
        const MAX = prov === 'lmstudio' ? 3000 : 20000
        let sizeLabel = '未知大小'
        try { const sz = fs.statSync(attach).size; sizeLabel = sz >= 1048576 ? (sz / 1048576).toFixed(1) + ' MB' : Math.round(sz / 1024) + ' KB' } catch (e) { /* ignore */ }
        const isLocalBig = prov === 'lmstudio' && content.length > MAX
        const note = isLocalBig
          ? '\n（文档较长：约 ' + content.length + ' 字 / ' + sizeLabel + '，本地模型上下文有限，只读取了前 ' + MAX + ' 字，无法完整翻译/总结全文。建议切换到 Codex/云端 来源处理整篇文档）'
          : (content.length > MAX ? '\n（已截取前 ' + MAX + ' 字符）' : '')
        if (isLocalBig) notice = '⚠️ 该文档较大（约 ' + content.length + ' 字，' + sizeLabel + '），本地模型只读了前 ' + MAX + ' 字，可能无法完整翻译/总结。建议先切到上方“Codex/云端”来源再发送全文。'
        effectiveMsg = '[附带文件: ' + path.basename(attach) + ']\n' + content.slice(0, MAX) + note + '\n\n' + effectiveMsg
        // 本地分流时预留一个截断到 3000 字的版本，避免本地模型装不下
        if (content.length > 3000) {
          localMsg = '[附带文件: ' + path.basename(attach) + ']\n' + content.slice(0, 3000) + '\n（文档较长：约 ' + content.length + ' 字，已截取前 3000 字供本地模型处理）\n\n' + msg
        }
      } else if (isPdf) {
        // PDF 文字抽不出来（扫描/编码字体）-> 渲染成图片给视觉模型读
        const img = await pdfToImage(attach)
        if (img) imagePath = img
        else effectiveMsg = effectiveMsg + '\n（附带文件：' + path.basename(attach) + '，无法读取）'
      } else {
        effectiveMsg = effectiveMsg + '\n（附带文件：' + path.basename(attach) + '）'
      }
    }
  }
  if (look && !imagePath) imagePath = await captureScreen(512)
  if (imagePath) imagePath = downscaleImage(imagePath, 512)
  const model = loadConfig().chatModel || ''
  const provider = loadConfig().chatProvider === 'lmstudio' ? 'lmstudio' : (loadConfig().chatProvider === 'llm' ? 'llm' : 'codex')
  // 本地分流判断：Codex 模式下，系统/网络等危险任务直接给 Codex；
  // 其余让本地模型自己判断；开着 MCP 时允许简单的写删改及只读/查询类调用分流到本地
  let useLocal = false
  // 本地分流：Codex / API 来源下都允许把“简单/文本”任务先交给本地模型省额度；本地来源本身就在本地，无需分流
  const routeOn = provider !== 'lmstudio' && loadConfig().chatLocalRoute === true
  if (routeOn) {
    const lmModel = await pickLocalModel()
    if (imagePath && !resolveVision(lmModel)) {
      useLocal = false // 本地模型不支持看图时，图片任务交给 Codex
    } else if (HARD_CODEX_RE.test(effectiveMsg)) {
      useLocal = false // 危险/系统级任务直接给 Codex
    } else {
      const classifyMsg = effectiveMsg + (imagePath ? '\n\n（用户还附带了一张图片/截图，你具备视觉能力，可结合图片内容判断）' : '')
      // 第一级：纯文本任务按原逻辑判断（不改变原有分流行为）
      let canLocal = await lmClassify(classifyMsg)
      // 第二级：纯文本判不了时，若开着 MCP 且有可用工具，让工具感知分类判断“简单调用”能否本地完成
      if (!canLocal && loadConfig().chatMcp === true) {
        const toolNames = await localMcpToolNames()
        if (toolNames.length) canLocal = await lmClassifyWithTools(classifyMsg, toolNames)
      }
      if (canLocal && lmModel) {
        // 委派前 token 上限守卫：本地模型装不下就退回 Codex，避免卡死
        const max = getLmMaxCtx(lmModel) || 6144
        const used = convTokens(conv) + estimateTokens(localMsg || effectiveMsg) + 24 + (imagePath ? 1200 : 0)
        useLocal = used <= max - 900
      }
    }
  }
  // 对话历史过长守卫：本地模型装不下就拦截，避免卡死占住唯一槽位
  if (provider === 'lmstudio') {
    const max = getLmMaxCtx(model) || 6144
    const used = convTokens(conv) + estimateTokens(effectiveMsg) + 24
    if (used > max - 900) {
      return { ok: false, error: '对话历史太长（约 ' + used + ' / ' + max + ' tokens），本地模型装不下，继续会卡死。请「新建对话」，或先切到上方 Codex/云端 来源。' }
    }
  }
  conv.messages = conv.messages || []
  const chosenMsg = useLocal ? (localMsg || effectiveMsg) : effectiveMsg
  conv.messages.push({ role: 'user', content: chosenMsg })
  if (!conv.title) conv.title = msg.slice(0, 40)
  touchConv(conv)
  saveConvs(arr)
  const sendStatus = (text) => { if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:status', { id, text }) }
  const sendDelta = (text) => { if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:delta', { id, text }) }
  const sendDone = (payload) => {
    if (payload.threadId && conv.threadId !== payload.threadId) { conv.threadId = payload.threadId }
    if (payload.text) { conv.messages = conv.messages || []; conv.messages.push({ role: 'assistant', content: payload.text }) }
    touchConv(conv)
    saveConvs(arr)
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:done', { id, ...payload })
  }
  if (provider === 'lmstudio') {
    runLmStudio(conv, model, imagePath, sendDelta, sendDone, sendStatus)
  } else if (provider === 'llm') {
    runLlm(conv, model, imagePath, sendDelta, sendDone, sendStatus)
  } else {
    if (useLocal) {
      sendStatus('本地模型正在回复…')
      pickLocalModel().then((lmModel) => {
        if (!lmModel) { sendDone({ error: '没有可用的本地模型。请先加载任意本地模型（LM Studio/Ollama 等）并启动服务。' }); return }
        runLmStudio(conv, lmModel, imagePath, sendDelta, (payload) => sendDone({ ...payload, via: 'local' }), sendStatus)
      })
    } else {
      // 首次给 Codex 准备好本地委派助手脚本
      try {
        const hp = path.join(chatWorkspace(), 'local-qwen.mjs')
        if (!fs.existsSync(hp)) fs.writeFileSync(hp, LOCAL_QWEN_SCRIPT, 'utf8')
      } catch (err) { /* 写不进去也不影响主流程 */ }
      sendStatus('Codex 正在处理…')
      const hint = routeOn ? LOCAL_DELEGATE_HINT + '\n\n' : ''
      runCodex(conv, hint + msg, model, imagePath, sendDelta, sendDone, sendStatus)
    }
  }
  return { ok: true, notice }
})
ipcMain.handle('pet:quit', () => {
  if (posSaveTimer) clearTimeout(posSaveTimer)
  app.quit()
})

// ---------------------------------------------------------------------------
// 启动（单实例 + whenReady）
// ---------------------------------------------------------------------------
const isSmokeTest = process.argv.includes('--smoke-test')
const isCaptureDemo = process.argv.includes('--capture-demo')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (petWin && !petWin.isDestroyed()) {
      petWin.show()
      petWin.focus()
    }
  })

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.deepseek-whale-pet')
    console.log('[boot] userData=' + app.getPath('userData'))
    loadStats()
    createPetWindow()
    applyDisplayMode(cfg.displayMode)
    updateHotkey(cfg.hotkey)

    if (isSmokeTest) {
      await new Promise((r) => setTimeout(r, 3500))
      if (petWin && !petWin.isDestroyed()) {
        try {
          const info = await petWin.webContents.executeJavaScript(`(() => {
            const el = (s) => document.querySelector(s)
            return {
              pet: !!el('.dshp-root'),
              imgLoaded: !!el('.dshp-img') && el('.dshp-img').complete && el('.dshp-img').naturalWidth > 0,
              label: el('.dshp-label') ? el('.dshp-label').textContent : null,
              time: el('.dshp-time') ? el('.dshp-time').textContent : null,
              amount: el('.dshp-amount') ? el('.dshp-amount').textContent : null,
              hint: el('.dshp-hint') ? el('.dshp-hint').textContent : null,
              bodyText: document.body.innerText,
            }
          })()`)
          console.log('[smoke] DOM=' + JSON.stringify(info))
          try {
            await petWin.webContents.executeJavaScript(`window.pet.setPosition(120, 130)`)
            await new Promise((r) => setTimeout(r, 400))
            const pos = await petWin.webContents.executeJavaScript(`window.pet.getPosition()`)
            console.log('[smoke] pos-ipc=' + JSON.stringify(pos))
          } catch (err) { console.error('[smoke] pos-ipc failed:', err) }
          const image = await petWin.webContents.capturePage()
          const outDir = process.env.WHALE_PET_SMOKE_DIR || app.getPath('temp')
          fs.mkdirSync(outDir, { recursive: true })
          const shot = path.join(outDir, 'whale-pet-smoke.png')
          fs.writeFileSync(shot, image.toPNG())
          const bmp = nativeImage.createFromBuffer(image.toPNG()).toBitmap()
          let opaque = 0
          const total = bmp.length / 4
          for (let i = 0; i < bmp.length; i += 4) if (bmp[i + 3] > 8) opaque++
          console.log('[smoke] pixels total=' + total + ' opaque=' + opaque + ' ratio=' + (opaque / total).toFixed(3))
          console.log('[smoke] screenshot=' + shot)

          // 设置窗口检查
          openSettings()
          await new Promise((r) => setTimeout(r, 1800))
          if (settingsWin && !settingsWin.isDestroyed()) {
            const sinfo = await settingsWin.webContents.executeJavaScript(
              `(() => ({
                title: document.title,
                hasInput: !!document.getElementById('keyInput'),
                hasLabel: !!document.getElementById('labelInput'),
                hasSnap: !!document.getElementById('snapInput'),
                hasUrl: !!document.getElementById('urlInput'),
                hasRefresh: !!document.getElementById('refreshInput'),
                hasLow: !!document.getElementById('lowAlertInput'),
                hasThreshold: !!document.getElementById('lowThresholdInput'),
                hasAutoStart: !!document.getElementById('autoStartInput'),
                hasIdle: !!document.getElementById('idleInput'),
                hasStats: !!document.getElementById('trackStatsInput'),
                hasMood: !!document.getElementById('moodInput'),
                hasBounce: !!document.getElementById('bounceInput'),
                hasSound: !!document.getElementById('soundInput'),
                hasQuotes: !!document.getElementById('quotesInput'),
                hasImage: !!document.getElementById('imageBtn'),
                hasHotkey: !!document.getElementById('hotkeyInput'),
                hasDisplayMode: !!document.querySelector('input[name=displayMode]'),
                hasAlwaysTop: !!document.getElementById('alwaysTopInput'),
                hasShowTime: !!document.getElementById('showTimeInput'),
              }))()`
            )
            console.log('[smoke] settings=' + JSON.stringify(sinfo))
          // 布局自检：body 不应滚动（避免双滚动条），只有内层滚动区滚动
          try {
            const lay = await settingsWin.webContents.executeJavaScript(`(() => {
              const sc = document.querySelector('.scroll')
              return {
                winH: window.innerHeight,
                bodyScrollH: document.body.scrollHeight,
                bodyOverflow: document.body.scrollHeight - window.innerHeight,
                scrollOverflow: sc ? sc.scrollHeight - sc.clientHeight : -1
              }
            })()`)
            console.log('[smoke] settings-layout=' + JSON.stringify(lay))
          } catch (err) { console.error('[smoke] settings-layout failed:', err) }
          // 设置窗口复选框是否反映保存的值（idleTransparency 应为 false）
          try {
            const boxes = await settingsWin.webContents.executeJavaScript(`(() => ({
              idle: document.getElementById('idleInput').checked,
              mood: document.getElementById('moodInput').checked,
              snap: document.getElementById('snapInput').checked,
            }))()`)
            console.log('[smoke] settings-boxes=' + JSON.stringify(boxes))
          // 自动保存自检：勾选 snap 开关（不点保存），等 1 秒看配置是否自动写入
          try {
            const snapBefore = loadConfig().snap
            await settingsWin.webContents.executeJavaScript(`(() => {
              var el = document.getElementById('snapInput')
              el.checked = true
              el.dispatchEvent(new Event('change', { bubbles: true }))
            })()`)
            await new Promise((r) => setTimeout(r, 1200))
            const snapAfter = loadConfig().snap
            console.log('[smoke] auto-save snap before=' + snapBefore + ' after=' + snapAfter)
          } catch (err) { console.error('[smoke] auto-save test failed:', err) }
          } catch (err) { console.error('[smoke] settings-boxes failed:', err) }
          // 音频状态检查（音效功能）
          try {
            const audioState = await petWin.webContents.executeJavaScript(`window.__dshpAudioTest()`)
            console.log('[smoke] audio-state=' + audioState)
          // 打印桌宠实际应用的功能开关（验证设置记忆）
          try {
            const flags = await petWin.webContents.executeJavaScript(`window.__dshpFlags ? window.__dshpFlags() : null`)
            const cfgState = await petWin.webContents.executeJavaScript(`window.__dshpConfig ? window.__dshpConfig() : null`)
            console.log('[smoke] applied-flags=' + JSON.stringify(flags) + ' cfg=' + JSON.stringify(cfgState))
          // 显示模式自检：4 种模式下桌宠都应始终可见（模式只影响任务栏/托盘图标）
          // 注意：切换任务栏组会重建桌宠窗口，因此从稳定的设置窗口发 saveSettings
          try {
            const visMap = {}
            for (const m of ['all', 'taskbar', 'tray', 'hidden']) {
              await settingsWin.webContents.executeJavaScript(`window.pet.saveSettings({ displayMode: '${m}' })`)
              await new Promise((r) => setTimeout(r, 2000))   // 重建窗口需时间
              visMap[m] = petWin.isVisible()
            }
            await settingsWin.webContents.executeJavaScript(`window.pet.saveSettings({ displayMode: 'all' })`)
            await new Promise((r) => setTimeout(r, 2000))
            console.log('[smoke] display-mode visible-map=' + JSON.stringify(visMap))
          } catch (err) { console.error('[smoke] display-mode test failed:', err) }
          } catch (err) { console.error('[smoke] flags check failed:', err) }
          // 刷新不闪 "--" 自检：模拟余额 10.00 -> 9.50，过程中数字应保持旧值并滚动
          try {
            const flashTest = await petWin.webContents.executeJavaScript(`(async () => {
              // 第一次：把余额设成 10.00
              window.__dshpSetFakeBalance({ ok: true, totalBalance: '10.00', currency: 'CNY' })
              window.__dshpTestRefresh()
              await new Promise(function (r) { setTimeout(r, 700) })
              var before = window.__dshpTestState()
              // 第二次：余额变成 9.50，且请求有 350ms 延迟（模拟自动刷新进行中）
              window.__dshpSetFakeBalance(function () {
                return new Promise(function (r) { setTimeout(function () {
                  r({ ok: true, totalBalance: '9.50', currency: 'CNY' })
                }, 350) })
              })
              window.__dshpTestRefresh()
              await new Promise(function (r) { setTimeout(r, 120) })   // 请求进行中：数字应保持 10.00，绝不是 "--"
              var during = window.__dshpTestState()
              await new Promise(function (r) { setTimeout(r, 800) })   // 等滚动动画完成
              var after = window.__dshpTestState()
              window.__dshpSetFakeBalance(null)
              return { before: before, during: during, after: after }
            })()`)
            console.log('[smoke] refresh-flash=' + JSON.stringify(flashTest))
          } catch (err) {
            console.error('[smoke] refresh-flash test failed:', err)
          }
          } catch (err) { console.error('[smoke] audio check failed:', err) }
          }
        } catch (err) {
          console.error('[smoke] failed:', err)
        }
      }
      app.quit()
      return
    }

    if (isCaptureDemo) {
      const outDir = process.env.WHALE_PET_CAPTURE_DIR || app.getPath('temp')
      fs.mkdirSync(outDir, { recursive: true })
      const save = async (w, name) => {
        if (!w || w.isDestroyed()) return
        const img = await w.webContents.capturePage()
        fs.writeFileSync(path.join(outDir, name), img.toPNG())
        console.log('[capture] ' + name)
      }
      await new Promise((r) => setTimeout(r, 3500))   // 等首次余额
      if (petWin && !petWin.isDestroyed()) {
        await save(petWin, 'shot-balance.png')
        // 余额上涨 -> 情绪 😊
        await petWin.webContents.executeJavaScript(`window.__dshpSetFakeBalance({ ok: true, totalBalance: '9.99', currency: 'CNY' })`)
        await petWin.webContents.executeJavaScript(`window.__dshpTestRefresh()`)
        await new Promise((r) => setTimeout(r, 1600))
        await save(petWin, 'shot-mood-up.png')
        // 低余额 -> 😰 红色
        await petWin.webContents.executeJavaScript(`window.__dshpSetFakeBalance({ ok: true, totalBalance: '2.00', currency: 'CNY' })`)
        await petWin.webContents.executeJavaScript(`window.__dshpTestRefresh()`)
        await new Promise((r) => setTimeout(r, 1600))
        await save(petWin, 'shot-low.png')
        // 恢复真实余额
        await petWin.webContents.executeJavaScript(`window.__dshpSetFakeBalance(null)`)
        await petWin.webContents.executeJavaScript(`window.__dshpTestRefresh()`)
        await new Promise((r) => setTimeout(r, 1200))
        // 右键菜单
        await petWin.webContents.executeJavaScript(`(() => {
          var m = document.getElementById('menu')
          m.style.left = '14px'; m.style.top = '8px'
          m.classList.add('dshp-open')
        })()`)
        await new Promise((r) => setTimeout(r, 500))
        await save(petWin, 'shot-menu.png')
        // 设置窗口
        openSettings()
        await new Promise((r) => setTimeout(r, 1600))
        if (settingsWin && !settingsWin.isDestroyed()) await save(settingsWin, 'shot-settings.png')
        console.log('[capture] done -> ' + outDir)
      }
      app.quit()
      return
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createPetWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
