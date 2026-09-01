'use strict'
var $ = function (id) { return document.getElementById(id) }
var keyInput = $('keyInput')
var labelInput = $('labelInput')
var urlInput = $('urlInput')
var refreshInput = $('refreshInput')
var snapInput = $('snapInput')
var lowAlertInput = $('lowAlertInput')
var lowThresholdInput = $('lowThresholdInput')
var trackStatsInput = $('trackStatsInput')
var idleInput = $('idleInput')
var idleSecInput = $('idleSecInput')
var moodInput = $('moodInput')
var showTimeInput = $('showTimeInput')
var bounceInput = $('bounceInput')
var soundInput = $('soundInput')
var quotesInput = $('quotesInput')
var quotesTextInput = $('quotesTextInput')
var customImageInput = $('customImageInput')
var imageBtn = $('imageBtn')
var autoStartInput = $('autoStartInput')
var hotkeyInput = $('hotkeyInput')
var chatHotkeyInput = $('chatHotkeyInput')
var alwaysTopInput = $('alwaysTopInput')
var clickThroughInput = $('clickThroughInput')
var clickThroughOpacityInput = $('clickThroughOpacityInput')
var chatProviderInput = $('chatProviderInput')
var llmBaseUrlInput = $('llmBaseUrlInput')
var llmApiKeyInput = $('llmApiKeyInput')
var llmModelInput = $('llmModelInput')
var localBaseUrlInput = $('localBaseUrlInput')
var localPresetInput = $('localPresetInput')
var saveBtn = $('saveBtn')
var testBtn = $('testBtn')
var statusEl = $('status')

function show(msg, cls) {
  statusEl.textContent = msg
  statusEl.className = cls || ''
}

window.pet.getFullConfig().then(function (c) {
  if (!c) return
  if (c.apiKey) keyInput.value = c.apiKey
  if (c.label) labelInput.value = c.label
  if (c.balanceUrl) urlInput.value = c.balanceUrl
  if (typeof c.refreshSec === 'number') refreshInput.value = c.refreshSec
  snapInput.checked = c.snap !== false
  lowAlertInput.checked = c.lowBalanceAlert !== false
  if (typeof c.lowThreshold === 'number') lowThresholdInput.value = c.lowThreshold
  trackStatsInput.checked = c.trackStats !== false
  idleInput.checked = c.idleTransparency !== false
  if (typeof c.idleSec === 'number') idleSecInput.value = c.idleSec
  moodInput.checked = c.mood !== false
  showTimeInput.checked = c.showTime !== false
  bounceInput.checked = c.bounceAnim !== false
  soundInput.checked = c.sound !== false
  quotesInput.checked = !!c.quotesEnabled
  if (c.quotesText) quotesTextInput.value = c.quotesText
  customImageInput.checked = !!c.customImage
  autoStartInput.checked = !!c.autoStart
  hotkeyInput.checked = c.hotkey !== false
  if (c.chatHotkey) chatHotkeyInput.value = c.chatHotkey
  alwaysTopInput.checked = c.alwaysOnTop !== false
  clickThroughInput.checked = c.clickThrough === true
  if (typeof c.clickThroughOpacity === 'number') clickThroughOpacityInput.value = c.clickThroughOpacity
  var dm = (c.displayMode === 'taskbar' || c.displayMode === 'tray' || c.displayMode === 'hidden') ? c.displayMode : 'all'
  var dmRadio = document.querySelector('input[name=displayMode][value="' + dm + '"]')
  if (dmRadio) dmRadio.checked = true
  chatProviderInput.value = (c.chatProvider === 'lmstudio' || c.chatProvider === 'llm') ? c.chatProvider : 'codex'
  llmBaseUrlInput.value = c.llmBaseUrl || ''
  llmApiKeyInput.value = c.llmApiKey || ''
  llmModelInput.value = c.llmModel || ''
  localBaseUrlInput.value = c.localBaseUrl || ''
  // 若当前地址恰好匹配某个预设，回显对应选项
  var presets = ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:11434/v1', 'http://127.0.0.1:8080/v1']
  if (c.localBaseUrl && presets.indexOf(c.localBaseUrl) >= 0) localPresetInput.value = c.localBaseUrl
})

function num(v, dft) {
  var n = parseFloat(v)
  return isFinite(n) ? n : dft
}

function collect() {
  return {
    apiKey: keyInput.value.trim(),
    label: labelInput.value.trim() || 'DeepSeek 余额',
    balanceUrl: urlInput.value.trim(),
    refreshSec: Math.max(0, Math.min(3600, Math.round(num(refreshInput.value, 30)))),
    snap: snapInput.checked,
    lowBalanceAlert: lowAlertInput.checked,
    lowThreshold: Math.max(0, num(lowThresholdInput.value, 5)),
    trackStats: trackStatsInput.checked,
    idleTransparency: idleInput.checked,
    idleSec: Math.max(1, Math.min(300, Math.round(num(idleSecInput.value, 5)))),
    mood: moodInput.checked,
    showTime: showTimeInput.checked,
    bounceAnim: bounceInput.checked,
    sound: soundInput.checked,
    quotesEnabled: quotesInput.checked,
    quotesText: quotesTextInput.value,
    customImage: customImageInput.checked,
    autoStart: autoStartInput.checked,
    hotkey: hotkeyInput.checked,
    chatHotkey: chatHotkeyInput.value.trim(),
    alwaysOnTop: alwaysTopInput.checked,
    clickThrough: clickThroughInput.checked,
    clickThroughOpacity: Math.max(0.2, Math.min(1, num(clickThroughOpacityInput.value, 0.6))),
    displayMode: (document.querySelector('input[name=displayMode]:checked') || {}).value || 'all',
    chatProvider: chatProviderInput.value === 'lmstudio' || chatProviderInput.value === 'llm' ? chatProviderInput.value : 'codex',
    llmBaseUrl: llmBaseUrlInput.value.trim(),
    llmApiKey: llmApiKeyInput.value.trim(),
    llmModel: llmModelInput.value.trim(),
    localBaseUrl: localBaseUrlInput.value.trim(),
  }
}

// 本地服务预设：选中后自动填入地址；选“自定义”则清空让用户手填
localPresetInput.addEventListener('change', function () {
  var v = localPresetInput.value
  if (v === '__custom__') { localBaseUrlInput.value = ''; localBaseUrlInput.focus(); return }
  if (v) { localBaseUrlInput.value = v }
})

// 任何开关/输入改动后自动保存（防抖 500ms），不用手动点保存
var saveTimer = null
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(function () {
    saveTimer = null
    window.pet.saveSettings(collect()).then(function (r) {
      if (r && r.ok) statusEl.textContent = '已自动保存 ✓'
      statusEl.className = r && r.ok ? 'ok' : 'err'
    })
  }, 500)
}
Array.prototype.forEach.call(document.querySelectorAll('input, textarea, select'), function (el) {
  el.addEventListener('change', scheduleSave)
  el.addEventListener('input', scheduleSave)
})

saveBtn.addEventListener('click', async function () {
  var r = await window.pet.saveSettings(collect())
  show(r && r.ok ? '已保存。桌宠已用新配置自动刷新。' : '保存失败', r && r.ok ? 'ok' : 'err')
})

testBtn.addEventListener('click', async function () {
  var r = await window.pet.saveSettings(collect())
  if (!r || !r.ok) { show('保存失败', 'err'); return }
  show('正在测试…', 'muted')
  var b = await window.pet.getBalance()
  if (b && b.ok) {
    show('✅ 连接成功，当前余额：' + (b.currency === 'CNY' ? '¥ ' : '') + Number(b.totalBalance).toFixed(2) + (b.currency !== 'CNY' && b.currency ? ' ' + b.currency : ''), 'ok')
  } else {
    show('❌ ' + ((b && b.error) || '测试失败'), 'err')
  }
})

imageBtn.addEventListener('click', async function () {
  var r = await window.pet.chooseImage()
  if (r && r.ok) {
    customImageInput.checked = true
    show('✅ 图片已设置，保存后生效。', 'ok')
  } else {
    show('未选择或读取失败。', 'err')
  }
})
