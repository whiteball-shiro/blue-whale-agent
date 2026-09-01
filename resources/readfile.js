// 附件文本读取：docx/xlsx/pptx(解压+XML提取)、txt类(直读)、pdf(尽力提取)。纯 JS，无外部依赖。
'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ---- 极简 ZIP 读取：返回 {文件名: Buffer} ----
function unzip(buf) {
  const out = {}
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return out
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    const lnameLen = buf.readUInt16LE(localOff + 26)
    const lextraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lnameLen + lextraLen
    let data = buf.subarray(dataStart, dataStart + compSize)
    if (method === 8) { try { data = zlib.inflateRawSync(data) } catch (e) { /* keep raw */ } }
    out[name] = Buffer.from(data)
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function decodeXml(esc) {
  return String(esc)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)) } catch (e) { return '' } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)) } catch (e) { return '' } })
}

function extractXmlText(buf) {
  const s = buf.toString('utf8')
  const texts = []
  const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g
  let m
  while ((m = re.exec(s))) texts.push(decodeXml(m[1]))
  return texts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function readOfficeText(p) {
  const ext = path.extname(p).toLowerCase()
  const files = unzip(fs.readFileSync(p))
  const out = []
  if (ext === '.docx') {
    if (files['word/document.xml']) out.push(extractXmlText(files['word/document.xml']))
  } else if (ext === '.xlsx') {
    if (files['xl/sharedStrings.xml']) out.push(extractXmlText(files['xl/sharedStrings.xml']))
    const sheets = Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()
    for (const k of sheets) { const t = extractXmlText(files[k]); if (t) out.push(t) }
  } else if (ext === '.pptx') {
    const slides = Object.keys(files).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    for (const k of slides) {
      const n = (k.match(/\d+/) || [''])[0]
      const t = extractXmlText(files[k])
      if (t) out.push('--- 第 ' + n + ' 页 ---\n' + t)
    }
  }
  return out.join('\n').trim()
}

function unescapePdf(s) { return s.replace(/\\(.)/g, (_, c) => c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c) }

function readPdfText(p) {
  const buf = fs.readFileSync(p)
  const s = buf.toString('latin1')
  const texts = []
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let m
  while ((m = streamRe.exec(s))) {
    let data
    try { data = zlib.inflateSync(Buffer.from(m[1], 'latin1')) } catch (e) { data = Buffer.from(m[1], 'latin1') }
    const cs = data.toString('latin1')
    // (text) Tj  与  [(a)(b)] TJ
    const opRe = /\(((?:\\.|[^()\\])*)\)\s*Tj|\[((?:\\.|[^\[\]\\])*)\]\s*TJ/g
    let tm
    while ((tm = opRe.exec(cs))) {
      if (tm[1] !== undefined) {
        // (text) Tj：tm[1] 即括号内文本
        texts.push(unescapePdf(tm[1]))
      } else {
        // [(a)(b)] TJ：tm[2] 是数组内容，逐个拆括号
        const pcs = []
        const pRe = /\(((?:\\.|[^()\\])*)\)/g
        let pm
        while ((pm = pRe.exec(tm[2]))) pcs.push(unescapePdf(pm[1]))
        texts.push(pcs.join(''))
      }
    }
  }
  return texts.join('').replace(/\n{3,}/g, '\n\n').trim()
}

const TEXT_EXTS = /\.(txt|md|markdown|csv|json|py|js|ts|tsx|jsx|log|ini|cfg|yaml|yml|html|htm|css|xml|rtf|conf|sh|bat|sql|properties)$/i

// 返回提取的文本（用于塞给模型）；读不了返回 ''
function readFileText(p) {
  try {
    const ext = path.extname(p).toLowerCase()
    if (TEXT_EXTS.test(ext)) {
      const t = fs.readFileSync(p, 'utf8')
      return String(t || '').slice(0, 20000)
    }
    if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') return readOfficeText(p).slice(0, 20000)
    if (ext === '.pdf') return readPdfText(p).slice(0, 20000)
  } catch (err) { /* ignore */ }
  return ''
}

module.exports = { readFileText }
