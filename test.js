const net = require('net'), zlib = require('zlib'), EventEmitter = require('events')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.8')
const Chunk = require('prismarine-chunk')('1.21.8')
const { startBridge, buildStateMap, pushOut, ruToLatin, latinToRu, SX, SY, SZ } = require('./bridge')
const smap = buildStateMap(mcData)

const sid = n => mcData.blocksByName[n].defaultState
// мир: плоская земля: y=60 трава, y=59..57 земля, y=56 камень; плюс по блоку для проверки
const cols = new Map()
function col(cx, cz) {
  const k = cx + ',' + cz
  if (!cols.has(k)) {
    const c = new Chunk()
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      c.setBlockStateId(new Vec3(x, 56, z), sid('stone'))
      for (let y = 57; y <= 59; y++) c.setBlockStateId(new Vec3(x, y, z), sid('dirt'))
      c.setBlockStateId(new Vec3(x, 60, z), sid('grass_block'))
    }
    cols.set(k, c)
  }
  return cols.get(k)
}
col(0, 0).setBlockStateId(new Vec3(1, 61, 1), sid('diamond_block'))     // -> стекло
col(0, 0).setBlockStateId(new Vec3(2, 61, 2), sid('red_wool'))          // -> 21
col(0, 0).setBlockStateId(new Vec3(3, 61, 3), sid('oak_log'))           // -> 17
col(0, 0).setBlockStateId(new Vec3(4, 61, 4), sid('short_grass'))       // -> 0

const calls = []
const fake = new EventEmitter()
Object.assign(fake, {
  entity: { position: new Vec3(8.5, 61, 8.5), yaw: 0, pitch: 0, onGround: true },
  entities: {}, game: { minY: -64, height: 384 },
  world: { getColumn: (x, z) => col(x, z) },
  inventory: Object.assign(new EventEmitter(), { slots: [] }),
  waitForChunksToLoad: async () => {},
  blockAt: p => ({ position: p, name: 'stone', stateId: sid('stone'), boundingBox: 'block', shapes: [] }),
  dig: async b => calls.push(['dig', b.position.toString()]),
  placeBlock: async (r, f) => calls.push(['place', r.position.toString(), f.toString()]),
  setQuickBarSlot: i => calls.push(['slot', i]),
  chat: m => calls.push(['chat', m]),
  end() {}
})
fake.inventory.slots[36] = { name: 'cobblestone' }
fake.inventory.slots[37] = { name: 'diamond_sword' }
fake.inventory.slots[38] = { name: 'oak_planks' }

const srv = startBridge({ port: 0, createBot: () => { setTimeout(() => fake.emit('spawn'), 20); return fake } })
const str64 = s => Buffer.from(s.padEnd(64, ' '), 'latin1')
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1 }

srv.on('listening', () => {
  const s = net.connect(srv.address().port, '127.0.0.1')
  let buf = Buffer.alloc(0), sentExt = false
  const got = { ops: [], hotbar: [], chunks: [], msgs: [], tp: [] }
  s.write(Buffer.concat([Buffer.from([0, 7]), str64('Tester'), str64('(none)'), Buffer.from([0x42])]))
  const SIZES = { 0x00: 131, 0x01: 1, 0x02: 1, 0x03: 1028, 0x04: 7, 0x06: 8, 0x07: 74, 0x08: 10, 0x0c: 2, 0x0d: 66, 0x0e: 65, 0x10: 67, 0x11: 69, 0x2d: 3 }
  let extCount = 0, extSeen = 0
  s.on('data', d => {
    buf = Buffer.concat([buf, d])
    while (buf.length && SIZES[buf[0]] && buf.length >= SIZES[buf[0]]) {
      const p = buf.subarray(0, SIZES[buf[0]]); buf = buf.subarray(SIZES[buf[0]])
      got.ops.push(p[0])
      if (p[0] === 0x10) extCount = p.readInt16BE(65)
      if (p[0] === 0x11) { extSeen++; if (extSeen === extCount && !sentExt) { sentExt = true
        s.write(Buffer.concat([Buffer.from([0x10]), str64('ClassiCube'), Buffer.from([0, 1]), Buffer.from([0x11]), str64('SetHotbar'), Buffer.from([0, 0, 0, 1])])) } }
      if (p[0] === 0x03) got.chunks.push(p.subarray(3, 3 + p.readInt16BE(1)))
      if (p[0] === 0x2d) got.hotbar.push([p[1], p[2]])
      if (p[0] === 0x08 && p[1] === 255) got.tp.push(p.readInt16BE(4) / 32 - 51 / 32)
      if (p[0] === 0x0d) got.msgs.push(p.toString('latin1', 2).trim())
      if (p[0] === 0x04 && !got.done) { got.done = true; setTimeout(() => finish(got, s), 200) }
      if (p[0] === 0x0e) console.log('KICK', p.toString('latin1', 1).trim())
    }
  })
})

function finish(got, s) {
  const i = got.ops.indexOf(0x00)
  ok(got.ops[0] === 0x10, 'CPE: первым пришёл ExtInfo (до идентификации)')
  ok(i > got.ops.indexOf(0x11), 'CPE: идентификация после ExtEntry')
  const lvl = zlib.gunzipSync(Buffer.concat(got.chunks))
  ok(lvl.readInt32BE(0) === SX * SY * SZ && lvl.length === 4 + SX * SY * SZ, `размер уровня ${SX}x${SY}x${SZ}`)
  // origin: x=floor(8.5)-64=-56, z=-56, y=floor(61)-32=29
  const ox = -56, oy = 29, oz = -56
  const at = (x, y, z) => lvl[4 + ((y - oy) * SZ + (z - oz)) * SX + (x - ox)]
  ok(at(5, 60, 5) === 2, 'трава -> 2')
  ok(at(5, 58, 5) === 3, 'земля -> 3')
  ok(at(5, 56, 5) === 1, 'камень -> 1')
  ok(at(1, 61, 1) === 28, 'алмазный блок -> голубая шерсть 28')
  ok(at(2, 61, 2) === 21, 'красная шерсть -> 21')
  ok(at(3, 61, 3) === 17, 'бревно -> 17')
  ok(at(4, 61, 4) === 0, 'короткая трава -> воздух')
  ok(at(5, 70, 5) === 0, 'воздух над землёй')
  ok(JSON.stringify(got.hotbar.slice(0, 3)) === JSON.stringify([[1, 0], [20, 1], [5, 2]]), 'хотбар: булыжник=1 (камень), меч->стекло 20, доски=5: ' + JSON.stringify(got.hotbar.slice(0, 3)))
  ok(got.ops.includes(0x07), 'spawn игрока после уровня')
  // действия клиента
  const sb = (x, y, z, m, t) => { const b = Buffer.alloc(9); b[0] = 5; b.writeInt16BE(x, 1); b.writeInt16BE(y, 3); b.writeInt16BE(z, 5); b[7] = m; b[8] = t; return b }
  s.write(sb(60, 40, 60, 0, 1))   // сломать
  s.write(sb(60, 41, 60, 1, 5))   // поставить доски
  const chat = Buffer.concat([Buffer.from([0x0d, 0xff]), str64('hello paper')]); s.write(chat)
  const mv = Buffer.alloc(10); mv[0] = 8; mv[1] = 255; mv.writeInt16BE(60 * 32, 2); mv.writeInt16BE(41 * 32 + 51, 4); mv.writeInt16BE(60 * 32, 6); s.write(mv)
  fake.emit('messagestr', '<Bob> hi there')
  s.write(Buffer.concat([Buffer.from([0x0d, 0xff]), str64('!ru')]))
  s.write(Buffer.concat([Buffer.from([0x0d, 0xff]), str64('privet, mir &a!')]))
  s.write(Buffer.concat([Buffer.from([0x0d, 0xff]), str64('!en')]))
  s.write(Buffer.concat([Buffer.from([0x0d, 0xff]), str64('privet')]))
  fake.emit('messagestr', '<Bob> Привет, мир! Щука')
  fake.emit('blockUpdate', { stateId: sid('stone') }, { position: new Vec3(ox + 10, oy + 10, oz + 10), stateId: sid('gold_block') })
  setTimeout(() => {
    console.log('bot calls:', JSON.stringify(calls))
    ok(calls.some(c => c[0] === 'dig' && c[1] === new Vec3(ox + 60, oy + 40, oz + 60).toString()), 'ломание -> bot.dig на правильной мировой координате')
    ok(calls.some(c => c[0] === 'place') && calls.some(c => c[0] === 'slot' && c[1] === 2), 'установка -> слот 2 (доски) + placeBlock')
    ok(calls.some(c => c[0] === 'chat' && c[1] === 'hello paper'), 'чат Classic -> Paper')
    ok(got.msgs.includes('<Bob> hi there'), 'чат Paper -> Classic')
    ok(got.msgs.includes('<Bob> Privet, mir! Shchuka'), 'русский из Paper показывается латиницей: ' + got.msgs.find(m => m.startsWith('<Bob> P')))
    ok(calls.some(c => c[0] === 'chat' && c[1] === 'привет, мир &a!'), '!ru: translit -> по-русски, цвета сохранены')
    ok(calls.some(c => c[0] === 'chat' && c[1] === 'privet'), '!en: обычный режим')
    ok(!calls.some(c => c[0] === 'chat' && c[1].startsWith('!')), 'команды !ru/!en не уходят в Paper')
    ok(Math.abs(fake.entity.position.x - (ox + 60)) < 0.01 && Math.abs(fake.entity.position.y - (oy + 41)) < 0.01, 'позиция клиента -> позиция бота')
    // правила замены блоков
    const id = n => smap[mcData.blocksByName[n].defaultState]
    const rules = { cobblestone: 1, nether_portal: 33, glowstone: 11, netherite_block: 34, sugar_cane: 37, oak_trapdoor: 44,
      poppy: 38, dandelion: 37, cornflower: 37, torch: 0, oak_stairs: 5, brick_stairs: 45, oak_slab: 44, white_carpet: 44, chest: 5 }
    for (const [n, e] of Object.entries(rules)) ok(id(n) === e, `${n} -> ${e} (получено ${id(n)})`)
    // застревание: сервер "телепортирует" бота в землю -> клиент должен получить позицию над землёй
    fake.entity.position = new Vec3(8.5, 58, 8.5)
    fake.emit('forcedMove')
    setTimeout(() => {
      const tp = got.tp[got.tp.length - 1]
      ok(tp && Math.abs(tp - 32) < 0.01, 'unstick: игрок из земли поднят на поверхность (y=' + tp + ', ожидалось 32)')
    }, 100)
    // у края окна: должна прийти перезагрузка уровня (второй 0x02)
    const mv2 = Buffer.alloc(10); mv2[0] = 8; mv2[1] = 255; mv2.writeInt16BE(10 * 32, 2); mv2.writeInt16BE(41 * 32 + 51, 4); mv2.writeInt16BE(64 * 32, 6)
    setTimeout(() => s.write(mv2), 2100)
    setTimeout(() => {
      ok(got.ops.filter(o => o === 0x02).length === 2, 'у края окна -> уровень отправлен повторно')
      process.exit()
    }, 3600)
  }, 400)
}


// ---- юнит-тест pushOut: стена и пол ----
{
  const wall = { x: 10, y: 60, z: 10 } // блок [10,11) x [60,61) x [10,11)
  const floorY = 59                       // пол: блок y=59, верх на 60
  const bot = { blockAt: p => {
    const full = (p.x === wall.x && p.y === wall.y && p.z === wall.z) || p.y === floorY
    return { position: p, boundingBox: full ? 'block' : 'empty', shapes: full ? [[0, 0, 0, 1, 1, 1]] : [] }
  } }
  const okp = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1 }
  // клиент Classic упёрся в стену слева: его полуширина 0.26875 -> у Paper внедрение 0.03125
  const p1 = { x: 10 - 0.26875, y: 60, z: 10.5 }
  pushOut(bot, p1)
  okp(p1.x <= 10 - 0.3 && 10 - p1.x - 0.3 < 0.01, `стена слева: игрок вытолкнут из блока (x=${p1.x.toFixed(4)})`)
  const p2 = { x: 11 + 0.26875 - 0.0, y: 60, z: 10.5 } // стена справа
  pushOut(bot, p2)
  okp(p2.x >= 11.3 && p2.x - 11.3 < 0.01, `стена справа: игрок вытолкнут (x=${p2.x.toFixed(4)})`)
  const p3 = { x: 5.5, y: 60, z: 5.5 } // стоит на полу, пересечений нет
  pushOut(bot, p3)
  okp(p3.x === 5.5 && p3.y === 60 && p3.z === 5.5, 'стоя на полу позиция не меняется')
  const p4 = { x: 5.5, y: 59.95, z: 5.5 } // чуть провалился в пол (ковёр/округление)
  pushOut(bot, p4)
  okp(p4.y >= 60 && p4.y - 60 < 0.01, `пол: игрока подняло на поверхность (y=${p4.y.toFixed(4)})`)
  const p5 = { x: 10.5, y: 60, z: 10.5 } // центр внутри блока: глубокое пересечение не трогаем
  pushOut(bot, p5)
  okp(p5.x === 10.5 && p5.z === 10.5, 'глубокое пересечение (>0.5) не трогаем')
}

{
  const okr = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1 }
  okr(ruToLatin('Привет, мир! Щука ёж') === 'Privet, mir! Shchuka yozh', 'ruToLatin: ' + ruToLatin('Привет, мир! Щука ёж'))
  okr(latinToRu('Privet, mir! Shchuka') === 'Привет, мир! Щука', 'latinToRu: ' + latinToRu('Privet, mir! Shchuka'))
  okr(latinToRu(ruToLatin('съешь же ещё этих мягких французских булок')) === 'съешь же ещё этих мягких французских булок', 'круг ru -> лат -> ru')
  okr(latinToRu('&aprivet &c!') === '&aпривет &c!', 'цветовые коды &a/&c сохраняются: ' + latinToRu('&aprivet &c!'))
}
