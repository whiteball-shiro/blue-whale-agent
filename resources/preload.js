// 预加载脚本：通过 contextBridge 暴露安全的桌宠 API 给渲染层
'use strict'
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  // 余额
  getBalance: () => ipcRenderer.invoke('pet:get-balance'),
  // 屏幕/位置
  getScreen: () => ipcRenderer.invoke('pet:get-screen'),
  getPosition: () => ipcRenderer.invoke('pet:get-position'),
  setPosition: (x, y) => ipcRenderer.invoke('pet:set-position', { x, y }),
  // 尺寸
  getSize: () => ipcRenderer.invoke('pet:get-size'),
  setScale: (scale) => ipcRenderer.invoke('pet:set-scale', { scale }),
  // 配置
  getConfig: () => ipcRenderer.invoke('pet:get-config'),
  getFullConfig: () => ipcRenderer.invoke('pet:get-full-config'),
  saveApiKey: (apiKey) => ipcRenderer.invoke('pet:save-key', { apiKey }),
  saveSettings: (settings) => ipcRenderer.invoke('pet:save-settings', settings),
  // 统计
  getStats: () => ipcRenderer.invoke('pet:get-stats'),
  // 闲置透明度
  setIdle: (idle) => ipcRenderer.invoke('pet:set-idle', { idle }),
  // 鼠标穿透
  toggleClickThrough: () => ipcRenderer.invoke('pet:set-click-through'),
  // 图片
  getImageUrl: () => ipcRenderer.invoke('pet:get-image-url'),
  chooseImage: () => ipcRenderer.invoke('pet:choose-image'),
  // 拖拽文件：从 File 对象取本地路径
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file) } catch (err) { return '' } },
  // 事件
  onRefreshRequested: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('pet:refresh', listener)
    return () => ipcRenderer.removeListener('pet:refresh', listener)
  },
  onConfigUpdated: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('pet:config-updated', listener)
    return () => ipcRenderer.removeListener('pet:config-updated', listener)
  },
  onChatOpen: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('pet:chat-open', listener)
    return () => ipcRenderer.removeListener('pet:chat-open', listener)
  },
  onChatClose: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('pet:chat-close', listener)
    return () => ipcRenderer.removeListener('pet:chat-close', listener)
  },
  onChatRequest: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('pet:chat-request', listener)
    return () => ipcRenderer.removeListener('pet:chat-request', listener)
  },
  setChat: (on) => ipcRenderer.invoke('pet:set-chat', { on }),
  // 对话（Codex）
  chat: {
    list: () => ipcRenderer.invoke('chat:list'),
    models: () => ipcRenderer.invoke('chat:models'),
    lmModels: () => ipcRenderer.invoke('chat:lm-models'),
    getProvider: () => ipcRenderer.invoke('chat:get-provider'),
    setProvider: (provider) => ipcRenderer.invoke('chat:set-provider', { provider }),
    getModel: () => ipcRenderer.invoke('chat:get-model'),
    getLlm: () => ipcRenderer.invoke('chat:get-llm'),
    setModel: (model) => ipcRenderer.invoke('chat:set-model', { model }),
    getLook: () => ipcRenderer.invoke('chat:get-look'),
    setLook: (look) => ipcRenderer.invoke('chat:set-look', { look }),
    getVision: () => ipcRenderer.invoke('chat:get-vision'),
    setVision: (on) => ipcRenderer.invoke('chat:set-vision', { on }),
    getThinking: () => ipcRenderer.invoke('chat:get-thinking'),
    setThinking: (on) => ipcRenderer.invoke('chat:set-thinking', { on }),
    getLocalRoute: () => ipcRenderer.invoke('chat:get-local-route'),
    setLocalRoute: (on) => ipcRenderer.invoke('chat:set-local-route', { on }),
    getMcp: () => ipcRenderer.invoke('chat:get-mcp'),
    setMcp: (on) => ipcRenderer.invoke('chat:set-mcp', { on }),
    setMcpServer: (id, on) => ipcRenderer.invoke('chat:set-mcp-server', { id, on }),
    getGpuStatus: () => ipcRenderer.invoke('chat:get-gpu-status'),
    ctxInfo: (id) => ipcRenderer.invoke('chat:ctx-info', { id }),
    get: (id) => ipcRenderer.invoke('chat:get', { id }),
    new: () => ipcRenderer.invoke('chat:new'),
    send: (id, message, look, attach) => ipcRenderer.invoke('chat:send', { id, message, look, attach }),
    stop: () => ipcRenderer.invoke('chat:stop'),
    grabClipboard: () => ipcRenderer.invoke('chat:grab-clipboard'),
    archive: (id, archived) => ipcRenderer.invoke('chat:archive', { id, archived }),
    del: (id) => ipcRenderer.invoke('chat:del', { id }),
    onDelta: (cb) => {
      const listener = (_e, d) => cb(d.id, d.text)
      ipcRenderer.on('chat:delta', listener)
      return () => ipcRenderer.removeListener('chat:delta', listener)
    },
    onDone: (cb) => {
      const listener = (_e, d) => cb(d.id, d)
      ipcRenderer.on('chat:done', listener)
      return () => ipcRenderer.removeListener('chat:done', listener)
    },
    onStatus: (cb) => {
      const listener = (_e, d) => cb(d.id, d.text)
      ipcRenderer.on('chat:status', listener)
      return () => ipcRenderer.removeListener('chat:status', listener)
    },
    onScreen: (cb) => {
      const listener = (_e, dataUrl) => cb(dataUrl)
      ipcRenderer.on('chat:screen', listener)
      return () => ipcRenderer.removeListener('chat:screen', listener)
    },
  },
  // 其它
  openChat: () => ipcRenderer.invoke('pet:open-chat'),
  closeChat: () => ipcRenderer.invoke('pet:close-chat'),
  pickFile: () => ipcRenderer.invoke('pet:pick-file'),
  fileExists: (p) => ipcRenderer.invoke('pet:file-exists', { p }),
  openSettings: () => ipcRenderer.invoke('pet:open-settings'),
  quit: () => ipcRenderer.invoke('pet:quit'),
})
