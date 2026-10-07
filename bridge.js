'use strict'
/*
 * Мост: клиент Minecraft Classic c0.30 / ClassiCube  <->  Paper 1.21.8
 *
 * Для каждого Classic-клиента поднимается mineflayer-бот (настоящий игрок на Paper).
 * Позиция бота берётся от Classic-клиента, мир отдаётся окном 128 x 128 x 128 вокруг игрока.
 *
 * Требования: Node.js >= 18, `npm i mineflayer`, на Paper online-mode=false
 * (бот заходит как offline-игрок). Если сервер открыт наружу, задайте BRIDGE_PASSWORD.
 */
const net = require('net')
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { promisify } = require('util')
const { Vec3 } = require('vec3')

const gzip = promisify(zlib.gzip)

const CFG = {
  listenPort: +process.env.LISTEN_PORT || 25566, // сюда заходит Classic-клиент
  mcHost: process.env.MC_HOST || '127.0.0.1', //     Paper
  mcPort: +process.env.MC_PORT || 25565,
  version: process.env.MC_VERSION || '1.21.8',
  password: process.env.BRIDGE_PASSWORD || '', //    пароль в поле Mppass клиента (пусто = без проверки)
  httpPort: +process.env.HTTP_PORT || 8080, //        раздача default.zip
  textureUrl: process.env.TEXTURE_URL || '', //       публичный URL текстурпака (<=64 символов); пусто = авто
  serverName: 'Paper bridge',
  motd: 'Classic -> Paper 1.21.8',
  viewDistance: 6, //                                 радиус прогрузки чанков ботом (меньше = легче серверу)
  edgeMargin: 24 //                                  ближе к краю окна -> перезагрузка мира
}

// Размер окна мира (Classic: x, y(высота), z)
const SX = 128
const SY = 128
const SZ = 128
const EYE = 51 / 32 // смещение глаз в Classic-протоколе

/* ------------------------- карта блоков (blocklist.txt) ------------------------- */
// blocklist.txt НЕОБЯЗАТЕЛЕН (id берутся из .cw по имени блока); если файл есть - его строки главнее. Формат:  имя_в_Minecraft = id_ClassiCube   (# - комментарий)
// default = N  - id для блоков, которых нет в списке. Состояния блоков игнорируются, важно только имя.
// air / cave_air / void_air = 0, если не заданы явно.
const GLASS = 20
const BLOCKLIST_FILE = process.env.BLOCKLIST || path.join(__dirname, 'blocklist.txt')

function loadBlocklist (file) {
  const names = new Map(); let def = 1
  let txt = ''
  try { txt = fs.readFileSync(file, 'utf8') } catch { /* blocklist.txt необязателен */ }
  for (const raw of txt.split(/\r?\n/)) {
    const m = /^([a-z0-9_:]+)\s*=\s*(\d+)$/i.exec(raw.replace(/#.*$/, '').trim())
    if (!m || +m[2] > 255) continue
    const name = m[1].toLowerCase().replace(/^minecraft:/, '')
    if (name === 'default') def = +m[2]; else names.set(name, +m[2])
  }
  return { names, def }
}

/* ---- определения блоков из .cw (ClassicWorld): Metadata.CPE.BlockDefinitions ---- */
function readNbt (buf) {
  let p = 0
  const str = () => { const n = buf.readUInt16BE(p); p += 2; return buf.toString('utf8', p, (p += n)) }
  const val = t => {
    switch (t) {
      case 1: return buf.readInt8(p++)
      case 2: { const v = buf.readInt16BE(p); p += 2; return v }
      case 3: { const v = buf.readInt32BE(p); p += 4; return v }
      case 4: case 6: p += 8; return 0
      case 5: { const v = buf.readFloatBE(p); p += 4; return v }
      case 7: { const n = buf.readInt32BE(p); p += 4; const v = n <= 64 ? Array.from(buf.subarray(p, p + n)) : null; p += n; return v }
      case 8: return str()
      case 9: { const et = buf[p]; const n = buf.readInt32BE(p + 1); p += 5; return Array.from({ length: n }, () => val(et)) }
      case 10: { const o = {}; for (;;) { const tt = buf[p++]; if (!tt) return o; const k = str(); o[k] = val(tt) } }
      case 11: { const n = buf.readInt32BE(p); p += 4 + 4 * n; return null }
      case 12: { const n = buf.readInt32BE(p); p += 4 + 8 * n; return null }
    }
    throw new Error('nbt: тег ' + t)
  }
  p++; str(); return val(10)
}
const normName = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
const CW_FILE = process.env.BLOCKDEFS || (fs.readdirSync(__dirname).find(f => /\.cw$/i.test(f)) || '')

let cwCache
function readCw () {
  if (cwCache) return cwCache
  cwCache = []
  if (!CW_FILE) return cwCache
  try {
    const root = readNbt(zlib.gunzipSync(fs.readFileSync(path.resolve(__dirname, CW_FILE))))
    cwCache = Object.values(root.Metadata?.CPE?.BlockDefinitions || {})
  } catch (e) { console.warn('[blockdefs]', e.message) }
  return cwCache
}

/** id (1..255) -> определение блока. В .cw три банка (ID2 = ID, ID+256, ID+512): берём тот, чьё имя совпало с blocklist.txt, иначе банк 0. */
function loadBlockDefs (names) {
  const defs = new Map()
  if (!CW_FILE) return defs
  const all = readCw()
  const byId = new Map()
  for (const d of all) { const id = d.ID & 255; if (!byId.has(id)) byId.set(id, []); byId.get(id).push(d) }
  const used = new Set(names.values())
  for (const id of used) {
    if (id < 1) continue
    const c = byId.get(id) || []
    // банк 0 (ID2 === id) всегда главнее: одинаковый младший байт у блока и у предмета из другого банка (вода 8 и ведро воды 264)
    const d = c.find(x => x.ID2 === id) || c.find(x => [...names].some(([n, v]) => v === id && n === normName(x.Name))) || c[0]
    if (d) defs.set(id, d)
  }
  console.log(`[blockdefs] ${CW_FILE}: определений в файле ${all.length}, будет отправлено ${defs.size}`)
  return defs
}

/** Таблица stateId -> id Classic: только по имени блока из blocklist.txt. */
function buildStateMap (mcData, file = BLOCKLIST_FILE) {
  const { names, def } = loadBlocklist(file) // blocklist.txt необязателен: если есть - его записи главнее
  // авто-список из .cw: имя блока (Stone -> stone, Oak Planks -> oak_planks) -> id, только банк 0 (ID2 = ID, 1..255)
  for (const d of readCw()) { const n = normName(d.Name); if (d.ID2 === (d.ID & 255) && d.ID2 > 0 && !names.has(n)) names.set(n, d.ID2) }
  // имена, которых нет среди блоков и предметов версии (варианты поворота _w/_n, свои блоки и т.п.) - не ошибка, просто не используются
  const unused = [...names.keys()].filter(n => !mcData.blocksByName[n] && !mcData.itemsByName?.[n])
  if (unused.length && process.env.BLOCKLIST_VERBOSE) console.log(`[blocklist] ${unused.length} имён не соответствуют блокам/предметам этой версии (игнорируются)` +
    (process.env.BLOCKLIST_VERBOSE ? ': ' + unused.join(', ') : ' (BLOCKLIST_VERBOSE=1 - показать список)'))
  const max = mcData.blocksArray.reduce((m, b) => Math.max(m, b.maxStateId), 0)
  const map = new Uint8Array(max + 1).fill(def)
  for (const b of mcData.blocksArray) {
    const id = names.get(b.name) ?? (/^(air|cave_air|void_air)$/.test(b.name) ? 0 : def)
    map.fill(id, b.minStateId, b.maxStateId + 1)
  }
  map.defs = loadBlockDefs(names)
  map.names = names // для предметов хотбара (diamond_sword = 107 и т.п.)
  return map
}


/* ------------------------- сборка мира ------------------------- */
function computeOrigin (pos, game) {
  const minY = game?.minY ?? -64
  const height = game?.height ?? 384
  const y = Math.max(minY, Math.min(minY + height - SY, Math.floor(pos.y) - 32))
  return { x: Math.floor(pos.x) - SX / 2, y, z: Math.floor(pos.z) - SZ / 2 }
}

/** Возвращает НЕсжатый буфер уровня: int32 BE размер + блоки, порядок (y * SZ + z) * SX + x. */
function buildLevelRaw (world, origin, stateMap) {
  const out = Buffer.alloc(4 + SX * SY * SZ)
  out.writeInt32BE(SX * SY * SZ, 0)
  const pos = { x: 0, y: 0, z: 0 }
  for (let cz = origin.z >> 4; cz <= (origin.z + SZ - 1) >> 4; cz++) {
    for (let cx = origin.x >> 4; cx <= (origin.x + SX - 1) >> 4; cx++) {
      const col = world.getColumn(cx, cz)
      if (!col) continue // не загружен -> воздух
      for (let lz = 0; lz < 16; lz++) {
        const z = cz * 16 + lz - origin.z
        if (z < 0 || z >= SZ) continue
        for (let lx = 0; lx < 16; lx++) {
          const x = cx * 16 + lx - origin.x
          if (x < 0 || x >= SX) continue
          pos.x = lx; pos.z = lz
          for (let y = 0; y < SY; y++) {
            pos.y = origin.y + y
            out[4 + (y * SZ + z) * SX + x] = stateMap[col.getBlockStateId(pos)]
          }
        }
      }
    }
  }
  return out
}

/* ------------------------- Classic-протокол ------------------------- */
const C2S = { 0x13: 2, 0x00: 131, 0x05: 9, 0x08: 10, 0x0d: 66, 0x10: 67, 0x11: 69 } // размеры пакетов клиента

const str64 = s => {
  const b = Buffer.alloc(64, 0x20)
  b.write(String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 64), 'latin1')
  return b
}
const readStr = (b, o) => b.toString('latin1', o, o + 64).trimEnd()
const fx = v => Math.max(-32768, Math.min(32767, Math.round(v * 32)))

function pkt (op, size, fill) {
  const b = Buffer.alloc(size)
  b[0] = op
  fill(b)
  return b
}

const P = {
  ident: (name, motd) => Buffer.concat([Buffer.from([0x00, 7]), str64(name), str64(motd), Buffer.from([0])]),
  ping: () => Buffer.from([0x01]),
  levelInit: () => Buffer.from([0x02]),
  levelData: (data, len, pct) => {
    const b = Buffer.alloc(1028)
    b[0] = 0x03; b.writeInt16BE(len, 1); data.copy(b, 3, 0, len); b[1027] = pct
    return b
  },
  levelDone: () => pkt(0x04, 7, b => { b.writeInt16BE(SX, 1); b.writeInt16BE(SY, 3); b.writeInt16BE(SZ, 5) }),
  setBlock: (x, y, z, t) => pkt(0x06, 8, b => { b.writeInt16BE(x, 1); b.writeInt16BE(y, 3); b.writeInt16BE(z, 5); b[7] = t }),
  spawn: (id, name, x, y, z, yaw, pitch) => Buffer.concat([
    Buffer.from([0x07, id & 255]), str64(name),
    pkt(0, 8, b => { b.writeInt16BE(fx(x), 0); b.writeInt16BE(fx(y), 2); b.writeInt16BE(fx(z), 4); b[6] = yaw; b[7] = pitch })
  ]),
  teleport: (id, x, y, z, yaw, pitch) => pkt(0x08, 10, b => {
    b[1] = id & 255; b.writeInt16BE(fx(x), 2); b.writeInt16BE(fx(y), 4); b.writeInt16BE(fx(z), 6); b[8] = yaw; b[9] = pitch
  }),
  despawn: id => Buffer.from([0x0c, id & 255]),
  message: (text, type = 0) => Buffer.concat([Buffer.from([0x0d, type]), str64(text)]), // type 100 = надпись над хотбаром
  weather: w => Buffer.from([0x1f, w]), //                                              0 ясно, 1 дождь
  tabAdd: (id, name, list) => { const b = Buffer.alloc(3); b[0] = 0x16; b.writeInt16BE(id, 1); return Buffer.concat([b, str64(name), str64(list), str64('Players'), Buffer.from([0])]) },
  spawnEnt: (id, x, y, z, yaw) => Buffer.concat([ // ExtAddEntity2: безымянная сущность (для мобов)
    Buffer.from([0x21, id & 255]), str64(''), str64(''),
    pkt(0, 8, b => { b.writeInt16BE(fx(x), 0); b.writeInt16BE(fx(y), 2); b.writeInt16BE(fx(z), 4); b[6] = yaw; b[7] = 0 })
  ]),
  model: (id, name) => Buffer.concat([Buffer.from([0x1d, id & 255]), str64(name)]), // ChangeModel
  defineBlock (id, d, ext, xt) { // DefineBlock 0x23 / DefineBlockExt 0x25 (+16-битные текстуры при ExtendedTextures)
    const T = d.Textures || []
    const tex = (...is) => Buffer.concat(is.map(i => { const v = ((T[i] ?? 0) & 255) | (((T[i + 6] ?? 0) & 255) << 8); return xt ? Buffer.from([v >> 8, v & 255]) : Buffer.from([v & 255]) }))
    const sp = Math.max(0, Math.min(255, Math.round(64 * Math.log2(d.Speed || 1) + 128)))
    const C = d.Coords || [0, 0, 0, 16, 16, 16]; const F = d.Fog || [0, 0, 0, 0]
    const b = x => Buffer.from(x.map(v => v & 255))
    return Buffer.concat([
      b([ext ? 0x25 : 0x23, id]), str64(d.Name || ('block' + id)), b([d.CollideType, sp]),
      ext ? tex(0, 2, 3, 4, 5, 1) : tex(0, 2, 1),
      b([d.TransmitsLight ? 1 : 0, d.WalkSound, d.FullBright ? 1 : 0]),
      ext ? b(C) : b([d.Shape]), b([d.BlockDraw, ...F])
    ])
  },
  tabRemove: id => { const b = Buffer.alloc(3); b[0] = 0x18; b.writeInt16BE(id, 1); return b },
  kick: reason => Buffer.concat([Buffer.from([0x0e]), str64(reason)]),
  extInfo: (app, n) => Buffer.concat([Buffer.from([0x10]), str64(app), Buffer.from([n >> 8, n & 255])]),
  extEntry: (name, ver) => {
    const v = Buffer.alloc(4)
    v.writeInt32BE(ver)
    return Buffer.concat([Buffer.from([0x11]), str64(name), v])
  },
  texUrl: url => Buffer.concat([Buffer.from([0x28]), str64(url)]), // EnvSetMapUrl
  hotbar: (block, index) => Buffer.from([0x2d, block, index])
}
const OUR_EXTS = [['SetHotbar', 1], ['EnvMapAspect', 1], ['EnvMapAppearance', 1], ['ExtPlayerList', 2], ['EnvWeatherType', 1], ['MessageTypes', 1], ['ChangeModel', 1], ['CustomBlocks', 1], ['BlockDefinitions', 1], ['BlockDefinitionsExt', 2], ['ExtendedTextures', 1]]
const TEX_FILE = process.env.TEXTURE_FILE || path.join(__dirname, 'default.zip')

/** Причина кика (строка JSON или NBT из 1.20.3+) -> обычный текст. */
function reasonText (r) {
  try {
    if (typeof r === 'string') { try { r = JSON.parse(r) } catch { return r } }
    if (r && typeof r === 'object' && r.type && r.value !== undefined) r = require('prismarine-nbt').simplify(r)
    const walk = c => {
      if (c == null) return ''
      if (typeof c !== 'object') return String(c)
      if (Array.isArray(c)) return c.map(walk).join('')
      let t = c.text ?? c.translate ?? ''
      if (c.with) t += ' ' + walk(c.with)
      if (c.extra) t += walk(c.extra)
      return t
    }
    return walk(r) || JSON.stringify(r)
  } catch { return 'unknown reason' }
}

// Мобы Paper -> модели ClassiCube (humanoid, chicken, creeper, pig, sheep, skeleton, spider, zombie, giant, ...).
// Чего нет в таблице - не показывается. Правьте под себя.
const MOBS = {
  sheep: 'sheep', pig: 'pig', cow: 'pig', mooshroom: 'pig', chicken: 'chicken', creeper: 'creeper',
  skeleton: 'skeleton', stray: 'skeleton', bogged: 'skeleton', wither_skeleton: 'skeleton',
  zombie: 'zombie', husk: 'zombie', drowned: 'zombie', zombie_villager: 'zombie', zombified_piglin: 'zombie',
  spider: 'spider', cave_spider: 'spider', villager: 'humanoid', enderman: 'humanoid', witch: 'humanoid',
  pillager: 'humanoid', vindicator: 'humanoid', iron_golem: 'giant'
}
const MAX_MOBS_ID = 100 // id Classic 0..126: мобам до 100, остальное для игроков

const yawByte = rad => Math.round((((rad * 180 / Math.PI) + 180) % 360 + 360) % 360 * 256 / 360) & 255

/* ------------------------- русский язык в чате ------------------------- */
// В Classic нет кириллицы (кодовая страница CP437), поэтому:
//  - сообщения с русским текстом из Paper показываются латиницей по таблице RU;
//  - в чате Classic можно ввести "!ru": дальше текст, набранный латиницей, уходит в Paper
//    по-русски (privet -> привет). "!en" возвращает обычный режим.
// Таблицу можно править: левая часть - русская буква, правая - как её показывать/набирать.
// Например, чтобы показывать "в" как "B", замените  в: 'v'  на  в: 'B'.
// Буква "э" набирается как e` (e и обратная кавычка), чтобы не путать её с "е".
const RU = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'j', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ъ: '"', ы: 'y', ь: "'", э: 'e`', ю: 'yu', я: 'ya'
}
const RU_ALIASES = { c: 'ц', x: 'кс', w: 'в', q: 'к' } // лишние латинские буквы при наборе
const RU_REV = new Map()
for (const [cyr, lat] of Object.entries(RU)) if (!RU_REV.has(lat.toLowerCase())) RU_REV.set(lat.toLowerCase(), cyr)
for (const [lat, cyr] of Object.entries(RU_ALIASES)) if (!RU_REV.has(lat)) RU_REV.set(lat, cyr)
const RU_MAXLEN = Math.max(...[...RU_REV.keys()].map(k => k.length))
const isUpper = ch => ch !== ch.toLowerCase()

/** Русский текст -> латиница (для показа в Classic). */
function ruToLatin (text) {
  let out = ''
  for (const ch of String(text)) {
    const lat = RU[ch.toLowerCase()]
    if (lat === undefined) { out += ch; continue }
    out += isUpper(ch) ? lat[0].toUpperCase() + lat.slice(1) : lat
  }
  return out
}

/** Текст, набранный латиницей -> русский ("privet" -> "привет"). Цвета &a и т.п. не трогает. */
function latinToRu (text) {
  const s = String(text)
  let out = ''
  for (let i = 0; i < s.length;) {
    if (s[i] === '&' && /[0-9a-fA-F]/.test(s[i + 1] || '')) { out += s.slice(i, i + 2); i += 2; continue }
    let done = false
    for (let n = Math.min(RU_MAXLEN, s.length - i); n >= 1 && !done; n--) {
      const cyr = RU_REV.get(s.substr(i, n).toLowerCase())
      if (cyr === undefined) continue
      out += isUpper(s[i]) ? cyr[0].toUpperCase() + cyr.slice(1) : cyr
      i += n; done = true
    }
    if (!done) out += s[i++]
  }
  return out
}

/* ------------------------- коллизии ------------------------- */
// Хитбокс игрока Paper: 0.6 x 1.8. Хитбокс клиента Classic уже (по моим данным у ClassiCube около
// 0.54 x 1.76), да ещё координаты округляются до 1/32 блока. Поэтому, упираясь в стену, клиент
// оказывается на ~0.03 внутри блока С ТОЧКИ ЗРЕНИЯ Paper, и тот откатывает игрока назад.
// pushOut() сдвигает позицию бота ровно настолько, чтобы хитбокс Paper не пересекал блоки.
const HALF_W = 0.3
const HEIGHT = 1.8
const PUSH_EPS = 1e-3
const MAX_PUSH = 0.5 // более глубокое пересечение не трогаем (это уже не округление)

function pushOut (bot, pos) {
  for (let iter = 0; iter < 4; iter++) {
    const x0 = pos.x - HALF_W; const x1 = pos.x + HALF_W
    const y0 = pos.y; const y1 = pos.y + HEIGHT
    const z0 = pos.z - HALF_W; const z1 = pos.z + HALF_W
    let best = null
    for (let bx = Math.floor(x0); bx < x1; bx++) {
      for (let by = Math.floor(y0); by < y1; by++) {
        for (let bz = Math.floor(z0); bz < z1; bz++) {
          const blk = bot.blockAt(new Vec3(bx, by, bz))
          if (!blk) continue
          const shapes = blk.shapes ?? (blk.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [])
          for (const s of shapes) {
            const sx0 = bx + s[0]; const sy0 = by + s[1]; const sz0 = bz + s[2]
            const sx1 = bx + s[3]; const sy1 = by + s[4]; const sz1 = bz + s[5]
            if (x0 >= sx1 || x1 <= sx0 || y0 >= sy1 || y1 <= sy0 || z0 >= sz1 || z1 <= sz0) continue
            for (const c of [[x1 - sx0, -1, 'x'], [sx1 - x0, 1, 'x'], [y1 - sy0, -1, 'y'], [sy1 - y0, 1, 'y'], [z1 - sz0, -1, 'z'], [sz1 - z0, 1, 'z']]) {
              if (!best || c[0] < best[0]) best = c
            }
          }
        }
      }
    }
    if (!best || best[0] > MAX_PUSH) return
    pos[best[2]] += best[1] * (best[0] + PUSH_EPS)
  }
}

/* ------------------------- сессия одного клиента ------------------------- */
class Session {
  constructor (sock, bridge) {
    this.sock = sock
    this.br = bridge
    this.buf = Buffer.alloc(0)
    this.name = null
    this.cpe = false
    this.extWanted = -1
    this.exts = new Set()
    this.bot = null
    this.origin = null
    this.grid = null // копия уровня Classic (для проверки застревания)
    this.ready = false
    this.loading = false
    this.lastReload = 0
    this.ru = !!process.env.RU_DEFAULT // режим набора по-русски ("!ru" / "!en")
    this.hotbar = [] //   что мы последний раз отправили клиенту в хотбар
    this.hotTimer = null
    this.lastY = 0
    this.work = Promise.resolve() // очередь действий с блоками
    this.ents = new Map() // entity.id -> classic id
    this.lastEnt = new Map()
    this.tab = new Map() //   username -> {id, text} (ExtPlayerList)
    this.lastStatus = ''
    this.weather = -1
    sock.setNoDelay(true)
    sock.on('data', d => this.onData(d))
    sock.on('close', () => this.close())
    sock.on('error', () => this.close())
    this.pingTimer = setInterval(() => this.send(P.ping()), 5000)
  }

  send (b) { if (!this.sock.destroyed) this.sock.write(b) }

  kick (reason) {
    this.send(P.kick(reason))
    setTimeout(() => this.sock.destroy(), 200)
    this.close()
  }

  close () {
    if (this.closed) return
    this.closed = true
    clearInterval(this.pingTimer)
    clearInterval(this.hotTimer)
    try { this.bot?.end() } catch {}
    this.sock.destroy()
  }

  onData (chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    while (this.buf.length) {
      const size = C2S[this.buf[0]]
      if (!size) return this.kick('Bad packet')
      if (this.buf.length < size) break
      const p = this.buf.subarray(0, size)
      this.buf = this.buf.subarray(size)
      try { this.handle(p[0], p) } catch (e) { console.error('handle', e) }
    }
  }

  handle (op, p) {
    switch (op) {
      case 0x00: return this.onIdent(p)
      case 0x10: // ExtInfo клиента
        this.extWanted = p.readInt16BE(65)
        if (this.extWanted === 0) this.start()
        return
      case 0x11: // ExtEntry клиента
        this.exts.add(readStr(p, 1))
        if (--this.extWanted === 0) this.start()
        return
      case 0x05: return this.onSetBlock(p)
      case 0x08: return this.onMove(p)
      case 0x0d: return this.onChat(p)
    }
  }

  onIdent (p) {
    if (this.name) return
    if (p[1] !== 7) return this.kick('Need protocol 7')
    const name = readStr(p, 2).replace(/[^A-Za-z0-9_]/g, '').slice(0, 16)
    if (!name) return this.kick('Bad name')
    if (CFG.password && readStr(p, 66) !== CFG.password) return this.kick('Wrong password (Mppass)')
    this.name = name
    if (p[130] === 0x42) { // клиент знает CPE: сначала согласуем расширения
      this.cpe = true
      this.send(P.extInfo('PaperBridge', OUR_EXTS.length))
      for (const [n, v] of OUR_EXTS) this.send(P.extEntry(n, v))
    } else this.start()
  }

  /* --- подключение бота к Paper --- */
  start () {
    console.log(`[${this.name}] classic connected, cpe=${this.cpe}, расширения клиента: ${[...this.exts].join(', ') || 'нет'}`)
    const bot = this.bot = this.br.createBot({
      host: CFG.mcHost, port: CFG.mcPort, username: this.name, auth: 'offline',
      version: CFG.version, physicsEnabled: false, viewDistance: CFG.viewDistance, hideErrors: true
    })
    bot.on('error', e => console.error(`[${this.name}] bot error`, e.message))
    bot.on('kicked', r => {
      const text = reasonText(r)
      console.log(`[${this.name}] kicked by Paper: ${text}`)
      this.kick(`Kicked: ${text}`.replace(/[^\x20-\x7e]/g, '').slice(0, 64))
    })
    bot.on('end', () => this.close())
    bot.once('spawn', () => this.onSpawn().catch(e => { console.error(e); this.kick('Load error') }))
  }

  async onSpawn () {
    const bot = this.bot
    await Promise.race([bot.waitForChunksToLoad(), new Promise(r => setTimeout(r, 8000))])
    this.origin = computeOrigin(bot.entity.position, bot.game)
    this.send(P.ident(CFG.serverName, CFG.motd))
    this.sendTexture()
    this.sendBlockDefs()
    await this.sendLevel()
    this.hookBot()
    this.ready = true
  }

  /** Посылает уровень целиком и ставит игрока на место бота. */
  async sendLevel () {
    const bot = this.bot
    this.loading = true
    for (const cid of this.ents.values()) this.send(P.despawn(cid))
    const raw = buildLevelRaw(bot.world, this.origin, this.br.stateMap)
    this.grid = raw
    const gz = await gzip(raw)
    this.send(P.levelInit())
    for (let off = 0; off < gz.length; off += 1024) {
      const len = Math.min(1024, gz.length - off)
      this.send(P.levelData(gz.subarray(off, off + len), len, Math.floor((off + len) * 100 / gz.length)))
    }
    this.send(P.levelDone())
    const e = bot.entity
    const px = e.position.x - this.origin.x; const pz = e.position.z - this.origin.z
    const py = this.unstick(px, e.position.y - this.origin.y, pz)
    this.send(P.spawn(-1, this.name, px, py + EYE, pz, yawByte(e.yaw), 0))
    this.lastY = py + this.origin.y
    this.syncHotbar(true)
    // ClassiCube может сбросить хотбар после загрузки уровня, поэтому шлём ещё раз
    for (const t of [400, 1500, 4000]) setTimeout(() => { if (!this.closed && this.ready) this.syncHotbar(true) }, t)
    setTimeout(() => { if (!this.closed && this.ready) { this.syncTab(true); this.sendWeather(true); this.sendStatus(true) } }, 600)
    for (const ent of Object.values(bot.entities || {})) this.trackEntity(ent)
    this.lastReload = Date.now()
    this.loading = false
  }

  /** CPE: если клиент умеет EnvMapAspect - отдаём ссылку на default.zip. */
  /** CPE CustomBlocks + BlockDefinitions: рассылаем определения блоков из .cw; Paper отдаёт только id. */
  sendBlockDefs () {
    const defs = this.br.stateMap.defs
    if (!defs?.size || !this.exts.has('CustomBlocks') || !this.exts.has('BlockDefinitions')) return
    this.send(Buffer.from([0x13, 1])) // CustomBlocks: уровень поддержки 1
    const ext = this.exts.has('BlockDefinitionsExt'); const xt = this.exts.has('ExtendedTextures')
    for (const [id, d] of defs) this.send(P.defineBlock(id, d, ext, xt))
  }

  sendTexture () {
    const why = !this.cpe ? 'клиент без CPE' : !fs.existsSync(TEX_FILE) ? `нет файла ${TEX_FILE}`
      : !(this.exts.has('EnvMapAspect') || this.exts.has('EnvMapAppearance')) ? 'клиент не заявил EnvMapAspect/EnvMapAppearance' : ''
    if (why) return console.log(`[${this.name}] текстурпак не отправлен: ${why}`)
    const url = CFG.textureUrl || `http://${String(this.sock.localAddress).replace(/^::ffff:/, '')}:${CFG.httpPort}/default.zip`
    if (url.length > 64) return console.warn(`[texture] URL длиннее 64 символов: ${url} (задайте TEXTURE_URL)`)
    // EnvMapAspect (0x28) или старый EnvMapAppearance v1 (0x1E: url, side=7, edge=8, level=0)
    this.send(this.exts.has('EnvMapAspect') ? P.texUrl(url)
      : Buffer.concat([Buffer.from([0x1e]), str64(url), Buffer.from([7, 8, 0, 0])]))
    console.log(`[${this.name}] текстурпак отправлен: ${url}`)
  }

  /* --- статусбар: HP и еда над хотбаром (CPE MessageTypes), команда .status --- */
  statusText () {
    const b = this.bot
    const hp = Math.max(0, Math.ceil(b.health ?? 0)); const food = Math.max(0, Math.round(b.food ?? 0))
    const bar = (v, c) => { const f = Math.min(10, Math.round(v / 2)); return `&8I${c}${'o'.repeat(f)}&8${'o'.repeat(10 - f)}I` }
    return `${bar(hp, '&c')} &f${hp} hp ${bar(food, '&6')} &f${food} eat`
  }

  sendStatus (force, chat) {
    if (!this.ready || !this.bot) return
    const t = this.statusText()
    if (!force && t === this.lastStatus) return
    this.lastStatus = t
    if (this.exts.has('MessageTypes')) this.send(P.message(t, 100))
    else if (chat) this.sendChat(t)
  }

  /* --- погода (CPE EnvWeatherType): дождь/гроза -> дождь --- */
  sendWeather (force) {
    if (!this.exts.has('EnvWeatherType') || !this.bot) return
    const w = this.bot.isRaining ? 1 : 0
    if (!force && w === this.weather) return
    this.weather = w
    this.send(P.weather(w))
  }

  /* --- TAB (CPE ExtPlayerList): игроки Paper + пинг --- */
  syncTab (force) {
    if (!this.exts.has('ExtPlayerList') || !this.bot?.players) return
    const seen = new Set()
    for (const p of Object.values(this.bot.players)) {
      if (!p.username) continue
      seen.add(p.username)
      let t = this.tab.get(p.username)
      if (!t) {
        const used = new Set([...this.tab.values()].map(v => v.id)); let id = 0
        while (used.has(id)) id++
        if (id > 254) continue
        this.tab.set(p.username, t = { id, text: null })
      }
      const text = ruToLatin(p.username) + (p.ping > 0 ? ` &7${p.ping}ms` : '')
      if (force || t.text !== text) { t.text = text; this.send(P.tabAdd(t.id, p.username, text)) }
    }
    for (const [n, t] of this.tab) if (!seen.has(n)) { this.send(P.tabRemove(t.id)); this.tab.delete(n) }
  }

  hookBot () {
    const bot = this.bot
    bot.on('messagestr', msg => this.sendChat(msg))
    bot.on('blockUpdate', (oldB, newB) => {
      if (!this.ready || !newB) return
      const p = newB.position
      const x = p.x - this.origin.x; const y = p.y - this.origin.y; const z = p.z - this.origin.z
      if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return
      const id = this.br.stateMap[newB.stateId]
      this.grid[4 + (y * SZ + z) * SX + x] = id
      if (oldB && this.br.stateMap[oldB.stateId] === id) return
      this.send(P.setBlock(x, y, z, id))
    })
    bot.on('forcedMove', () => {
      if (!this.ready) return
      if (this.outsideWindow(bot.entity.position)) return this.reload()
      const e = bot.entity
      const px = e.position.x - this.origin.x; const pz = e.position.z - this.origin.z
      const py = this.unstick(px, e.position.y - this.origin.y, pz)
      this.send(P.teleport(-1, px, py + EYE, pz, yawByte(e.yaw), 0))
      this.lastY = py + this.origin.y
    })
    bot.inventory?.on('updateSlot', slot => { if (slot >= 36 && slot <= 44) this.syncHotbar() })
    this.hotTimer = setInterval(() => this.syncHotbar(), 1000) // страховка, если событие инвентаря пропущено
    bot.on('health', () => this.sendStatus())
    bot.on('weatherUpdate', () => this.sendWeather())
    for (const ev of ['playerJoined', 'playerLeft', 'playerUpdated']) bot.on(ev, () => this.syncTab())
    bot.on('entitySpawn', e => this.trackEntity(e))
    bot.on('entityMoved', e => this.trackEntity(e))
    bot.on('entityGone', e => {
      const cid = this.ents.get(e.id)
      if (cid === undefined) return
      this.ents.delete(e.id); this.lastEnt.delete(e.id)
      this.send(P.despawn(cid))
    })
  }

  /**
   * Если клиентские координаты (x, y=ноги, z) оказались внутри твёрдого блока Classic,
   * поднимает игрока до ближайшего свободного места (до 24 блоков вверх).
   */
  unstick (x, y, z) {
    if (!this.grid) return y
    const gx = Math.floor(x); const gz = Math.floor(z)
    const cy = Math.floor(y)
    const free = id => id === 0 || id === 6 || (id >= 8 && id <= 11) || (id >= 37 && id <= 40)
    const at = yy => (gx < 0 || gz < 0 || gx >= SX || gz >= SZ || yy < 0 || yy >= SY) ? 0 : this.grid[4 + (yy * SZ + gz) * SX + gx]
    const feetOk = yy => { const id = at(yy); return free(id) || (id === 44 && yy === cy && y - cy >= 0.49) }
    if (feetOk(cy) && free(at(cy + 1))) return y
    for (let i = 1; i <= 24; i++) if (free(at(cy + i)) && free(at(cy + i + 1))) return cy + i
    return y
  }

  /* --- другие игроки --- */
  trackEntity (e) {
    if (!this.ready && !this.loading) return
    if (!e || e === this.bot.entity) return
    const isP = e.type === 'player' && !!e.username
    const model = isP ? null : MOBS[e.name]
    if (!isP && (!model || !this.exts.has('ChangeModel') || !this.exts.has('ExtPlayerList'))) return
    const o = this.origin
    const x = e.position.x - o.x; const y = e.position.y - o.y; const z = e.position.z - o.z
    const inside = x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ
    let cid = this.ents.get(e.id)
    if (!inside) {
      if (cid !== undefined) { this.ents.delete(e.id); this.send(P.despawn(cid)) }
      return
    }
    if (cid === undefined) {
      const used = new Set(this.ents.values())
      for (cid = 0; cid < 127 && used.has(cid); cid++);
      if (cid >= (isP ? 127 : MAX_MOBS_ID)) return
      this.ents.set(e.id, cid)
      if (isP) this.send(P.spawn(cid, e.username, x, y + EYE, z, yawByte(e.yaw), 0))
      else { this.send(P.spawnEnt(cid, x, y + EYE, z, yawByte(e.yaw))); this.send(P.model(cid, model)) }
      return
    }
    const now = Date.now()
    if (now - (this.lastEnt.get(e.id) || 0) < 60) return
    this.lastEnt.set(e.id, now)
    this.send(P.teleport(cid, x, y + EYE, z, yawByte(e.yaw), 0))
  }

  /* --- Classic -> Paper --- */
  outsideWindow (p) {
    const o = this.origin; const m = CFG.edgeMargin
    return p.x - o.x < m || p.x - o.x > SX - m || p.z - o.z < m || p.z - o.z > SZ - m ||
      p.y - o.y < 8 || p.y - o.y > SY - 16
  }

  reload () {
    if (this.loading || Date.now() - this.lastReload < 2000) return
    this.loading = true
    ;(async () => {
      try {
        await Promise.race([this.bot.waitForChunksToLoad(), new Promise(r => setTimeout(r, 4000))])
        this.origin = computeOrigin(this.bot.entity.position, this.bot.game)
        this.ents.clear(); this.lastEnt.clear()
        await this.sendLevel()
      } catch (e) { console.error('reload', e); this.loading = false }
    })()
  }

  onMove (p) {
    if (!this.ready || this.loading) return
    const o = this.origin; const e = this.bot.entity
    const x = o.x + p.readInt16BE(2) / 32
    const y = o.y + p.readInt16BE(4) / 32 - EYE
    const z = o.z + p.readInt16BE(6) / 32
    e.position.set(x, y, z)
    pushOut(this.bot, e.position) //  не даём Paper откатывать игрока из-за разницы хитбоксов
    e.onGround = Math.abs(e.position.y - this.lastY) < 0.001
    this.lastY = e.position.y
    e.yaw = (p[8] * 360 / 256 + 180) * Math.PI / 180 // гипотеза: углы Classic = Notchian
    e.pitch = -((p[9] > 127 ? p[9] - 256 : p[9]) * 360 / 256) * Math.PI / 180
    if (this.outsideWindow(e.position)) this.reload()
  }

  onChat (p) {
    const msg = readStr(p, 2).trim()
    if (!msg || !this.ready) return
    const cmd = msg.toLowerCase()
    if (cmd === '!ru') { this.ru = true; return this.sendChat('&aRU rezhim vkljuchen: pishite translitom (privet = привет). !en - vyhod') }
    if (cmd === '!en') { this.ru = false; return this.sendChat('&aRU rezhim vykljuchen') }
    if (cmd === '.status' || cmd === '!status') return this.sendStatus(true, true)
    this.bot.chat(this.ru && !msg.startsWith('/') ? latinToRu(msg) : msg)
  }

  onSetBlock (p) {
    if (!this.ready || this.loading) return
    const [x, y, z] = [p.readInt16BE(1), p.readInt16BE(3), p.readInt16BE(5)]
    const mode = p[7]; const type = p[8]
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return
    // действия по очереди, чтобы dig/place не пересекались
    this.work = this.work.then(async () => {
      const o = this.origin
      const pos = new Vec3(o.x + x, o.y + y, o.z + z)
      try {
        if (mode === 0) {
          const b = this.bot.blockAt(pos)
          if (b && b.name !== 'air') await this.bot.dig(b, true)
        } else await this.place(pos, type)
      } catch (e) { /* не вышло: ниже вернём клиенту реальный блок */ }
      const real = this.bot.blockAt(pos)
      if (real) this.send(P.setBlock(x, y, z, this.br.stateMap[real.stateId]))
    }).catch(() => {})
  }

  async place (pos, type) {
    const slot = this.hotbarSlotFor(type)
    if (slot < 0) throw new Error('no item')
    this.bot.setQuickBarSlot(slot)
    for (const f of [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(-1, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1)]) {
      const ref = this.bot.blockAt(pos.plus(f))
      if (ref && ref.boundingBox === 'block') return this.bot.placeBlock(ref, f.scaled(-1))
    }
    throw new Error('no reference block')
  }

  /* --- хотбар (9 слотов, CPE SetHotbar) --- */
  itemClassic (item) {
    if (!item) return 0
    const id = this.br.itemId(item.name) //                  не блок -> стекло
    return id === undefined || id === 0 ? GLASS : id
  }

  hotbarSlotFor (type) {
    for (let i = 0; i < 9; i++) {
      const it = this.bot.inventory.slots[36 + i]
      if (it && this.br.itemId(it.name) === type) return i
    }
    return -1
  }

  /** Отправляет хотбар Paper -> ClassiCube. force=true шлёт все 9 слотов заново. */
  syncHotbar (force) {
    if (!this.bot?.inventory) return
    if (!this.exts.has('SetHotbar')) {
      if (force && !this.warnedHotbar) {
        this.warnedHotbar = true
        console.log(`[${this.name}] клиент НЕ заявил расширение SetHotbar -> хотбар показать нельзя (его расширения: ${[...this.exts].join(', ') || 'нет'}). Обновите ClassiCube.`)
      }
      return
    }
    const names = []
    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[36 + i]
      const id = this.itemClassic(item)
      names.push(item ? `${item.name}=${id}` : '-')
      if (force || this.hotbar[i] !== id) { this.hotbar[i] = id; this.send(P.hotbar(id, i)) }
    }
    const line = names.join(' | ')
    if (force && line !== this.lastHotLog) { this.lastHotLog = line; console.log(`[${this.name}] хотбар -> ${line}`) }
  }

  /* --- чат Paper -> Classic --- */
  sendChat (text) {
    const clean = ruToLatin(String(text).replace(/§./g, '')).replace(/[^\x20-\x7e]/g, '?')
    for (let i = 0; i < clean.length; i += 64) this.send(P.message(clean.slice(i, i + 64)))
  }
}

/* ------------------------- запуск ------------------------- */
function startBridge (opts = {}) {
  const mcData = opts.mcData || require('minecraft-data')(CFG.version)
  const br = {
    mcData,
    stateMap: buildStateMap(mcData),
    itemId (name) { const b = mcData.blocksByName[name]; return b ? this.stateMap[b.defaultState] : this.stateMap.names?.get(name) },
    createBot: opts.createBot || (o => require('mineflayer').createBot(o))
  }
  if (opts.http !== false) {
    const web = http.createServer((req, res) => {
      console.log(`[texture] http ${req.method} ${req.url} от ${req.socket.remoteAddress}`)
      if (!fs.existsSync(TEX_FILE)) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(TEX_FILE).size })
      fs.createReadStream(TEX_FILE).pipe(res)
    })
    web.on('error', e => console.warn('[texture] http:', e.message))
    web.listen(opts.httpPort ?? CFG.httpPort)
  }
  const server = net.createServer(sock => new Session(sock, br))
  server.listen(opts.port ?? CFG.listenPort, () => console.log(`Classic bridge on :${server.address().port} -> ${CFG.mcHost}:${CFG.mcPort} (${CFG.version})`))
  return server
}

module.exports = { ruToLatin, latinToRu, pushOut, reasonText, startBridge, buildStateMap, buildLevelRaw, computeOrigin, SX, SY, SZ }
if (require.main === module) startBridge()