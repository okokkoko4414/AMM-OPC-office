/**
 * Hermes Office — a floor of desks for every Bot Mode agent.
 *
 * Same data as Bot Mode: profiles.list, ui_meta hermes-bots, routed session events.
 * Click a nameplate to give them a task. That task lands in the same
 * Bot Chat session Bot Mode already uses. Hover, pet, and drag the face.
 */

import {
  atom,
  cn,
  haptic,
  host,
  PALETTE_AREA,
  profileColor,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  Tip,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { Fragment, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'amm-opc-office'
const ROSTER_KEY = [ID, 'roster']
const META_NS = 'hermes-bots'
const DRAG_PX = 8
const SLEEP_HOLD_MS = 1200
const $seats = atom({})
const $drag = atom(null)
const $fx = atom({})
const $peekUntil = atom(0)
const $walks = atom({})
const $roam = atom({})
const $clockKind = atom('digital')
const $clockPos = atom(null)
const $selected = atom(null)
const $focusTask = atom(0)
const $jobs = atom({})
const $backdrop = atom('carpet')
const $game = atom(null)
const $pizza = atom({ winner: null, at: 0 })
const $puffs = atom([])
const $planes = atom([])
const $trophies = atom({})
const $lastTask = atom({})
const $week = atom(null)
const $month = atom(null)
const $hint = atom('off')
const $news = atom({})
const $officeInput = atom({})
const $ritual = atom({ hour: -1, at: 0 })
const JOBS_STORAGE_KEY = 'jobs'
const JOBS_SCHEMA_VERSION = 1
const JOB_STATES = Object.freeze({ SUBMITTING: 'submitting', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', UNKNOWN: 'unknown' })
const TASK_PROMPT_MAX = 4000
let jobSequence = 0
let openSequence = 0
const RITUAL_MS = 2800
const RITUAL_WINDOW_MS = 10 * 60 * 1000
const $petPing = atom({})
const OFFICE_NS = 'amm-opc-office'
const BORED_MS = 2 * 24 * 60 * 60 * 1000
let puffSeq = 0

// A paper plane from the task bar to a desk. Root relative coordinates.
function flyPlane(from, to) {
  if (!from || !to) {
    return
  }

  const id = ++puffSeq
  $planes.set([...$planes.get(), { id, from, to }])
  setTimeout(() => {
    $planes.set($planes.get().filter(p => p.id !== id))
  }, 900)
}

// One more finished task on the shelf for this bot. Kept locally for speed and
// mirrored onto the bot's profile (ui_meta, our own namespace) so the count
// follows the profile rather than this machine.
function addTrophy(name, route = null) {
  const count = ($trophies.get()[name] || 0) + 1
  const next = { ...$trophies.get(), [name]: count }
  $trophies.set(next)
  savePref('trophies', next)

  try {
    Promise.resolve(
      requestForBot({ name, route }, 'profiles.configure', { name, ui_meta: { [OFFICE_NS]: { stars: count } } })
    ).catch(() => undefined)
  } catch {
    /* older gateway */
  }
}

// If the profile already carries more stars than we know about (another
// machine, or a fresh install), take the higher number.
function seedTrophies(roster) {
  const local = $trophies.get()
  let changed = false
  const next = { ...local }

  for (const bot of roster || []) {
    const stars = Number(bot?.ui_meta?.[OFFICE_NS]?.stars || 0)
    if (stars > (next[bot.name] || 0)) {
      next[bot.name] = stars
      changed = true
    }
  }

  if (changed) {
    $trophies.set(next)
    savePref('trophies', next)
  }
}

// Employee of the month: tasks per bot this calendar month.
function bumpMonth(name) {
  const next = monthBump($month.get(), name, Date.now())
  $month.set(next)
  savePref('month', next)
}

// No board for this month yet (first run of the feature, or a fresh install
// with stars on the profiles): start it from the all time stars so the wall is
// not empty. From then on it counts real completions and resets on the first.
function seedMonth(roster) {
  const cur = $month.get()
  const start = monthStart(new Date())
  if (cur) {
    return
  }

  const stars = $trophies.get()
  const tasks = {}
  for (const bot of roster || []) {
    if (stars[bot.name] > 0) {
      tasks[bot.name] = stars[bot.name]
    }
  }

  const holder = monthLeader({ tasks }, null)
  if (!holder) {
    return
  }

  const next = { start, tasks, holder, seeded: true }
  $month.set(next)
  savePref('month', next)
}

// Weekly recap: a few counters that reset every Monday.
function bumpWeek(key, name) {
  const now = Date.now()
  const next = weekBump($week.get(), key, name, now)
  $week.set(next)
  savePref('week', next)
}

// Job done: confetti at the desk, a trophy, then off to the bar.
// The event stream and recovery poll can see the same completion. Each round
// gets a token in startRound, so those two paths can celebrate it only once.
function celebrate(name, route = null) {
  const now = Date.now()
  const row = $fx.get()[name] || {}
  const round = completionToken(row)
  if (round === null) {
    return
  }

  patchFx(name, { doneRound: round, clapUntil: now + 1100, confettiUntil: now + 950, bangUntil: now + 1500, nap: false, goBar: true, goHome: false })
  const quirk = officeQuirk(name)
  officeSay(name, quirk.id === 'champion' ? '又一次载入史册的交付！' : quirk.id === 'quiet' ? '你的包裹好了。' : quirk.line)
  if (quirk.id === 'quiet') patchFx(name, { clapUntil: 0, confettiUntil: 0 })
  addTrophy(name, route)
  bumpWeek('tasks', name)
  bumpMonth(name)
  rememberOffice('work', `${displayName({ name }, {})} 交付了成果。`, [name])
  leaveNote(name, now)
  advanceHint('play')
}

// A finished task leaves a note on the desk until the chat is opened.
function leaveNote(name, at) {
  const next = { ...$news.get(), [name]: at || Date.now() }
  $news.set(next)
  savePref('news', next)
}

function readNote(name) {
  if (!$news.get()[name]) {
    return
  }
  const next = { ...$news.get() }
  delete next[name]
  $news.set(next)
  savePref('news', next)
}

// A little dust ring at a foot position. Gone after half a second.
function puffAt(x, y) {
  const id = ++puffSeq
  $puffs.set([...$puffs.get(), { id, x, y, t0: Date.now() }])
  setTimeout(() => {
    $puffs.set($puffs.get().filter(p => p.id !== id))
  }, 520)
}

// Honour the OS "reduce motion" setting for the bouncy bits. Walks stay.
let reducedCache = null
function reducedMotion() {
  if (reducedCache === null) {
    reducedCache = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  }
  return reducedCache
}
const PIZZA_MS = 14000

// Room skins. Every skin is a flat wall band plus a seamless floor tile, drawn
// as tiny SVGs and embedded as data URIs (Hermes loads plugin.js through a blob
// URL, so sibling image files are not served). Nothing here has a vanishing
// point: the paper-doll sprites and CSS desks sit on this floor, so the floor
// has to be the same flat plane they are.
const WALL_H = 86

function svgUri(svg) {
  const flat = svg.replace(/\s+/g, ' ').replace(/> </g, '><').trim()
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(flat)}`
}

function svgTile(width, height, body) {
  return svgUri(`<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'>${body}</svg>`)
}

function speckle(points, fill, r = 1) {
  return `<g fill='${fill}'>${points.map(([x, y]) => `<circle cx='${x}' cy='${y}' r='${r}'/>`).join('')}</g>`
}

// Running bond bricks. Tile width must be a multiple of brick + joint and the
// colour list must be exactly four long so the half-offset rows wrap cleanly.
const OFFICE_SKINS = {
  carpet: {
    wallColor: '#ebe2d1',
    wallSize: '160px 86px',
    wall: svgTile(160, WALL_H, `
      <rect width='160' height='86' fill='#ebe2d1'/>
      ${speckle([[23, 14], [71, 38], [118, 22], [143, 49], [47, 51], [95, 9], [12, 44], [131, 8]], '#e1d6c2')}
      <rect y='60' width='160' height='3' fill='#c9b99d'/>
      <rect y='60' width='160' height='1' fill='#f7f1e4'/>
      <rect y='63' width='160' height='17' fill='#dccfb7'/>
      <g fill='#c6b699'><rect x='39' y='66' width='2' height='11'/><rect x='79' y='66' width='2' height='11'/><rect x='119' y='66' width='2' height='11'/><rect x='159' y='66' width='1' height='11'/><rect y='66' width='1' height='11'/></g>
      <rect y='80' width='160' height='6' fill='#8a755b'/>
      <rect y='80' width='160' height='1' fill='#aa937b'/>
    `),
    floorColor: '#587e8f',
    floorSize: '96px 96px',
    floor: svgTile(96, 96, `
      <rect width='96' height='96' fill='#587e8f'/>
      <rect x='48' width='48' height='48' fill='#557b8c'/>
      <rect y='48' width='48' height='48' fill='#557b8c'/>
      ${speckle([[6, 9], [21, 30], [39, 14], [30, 42], [11, 38], [58, 6], [70, 27], [88, 12], [79, 41], [63, 39], [9, 57], [27, 74], [41, 60], [18, 89], [36, 84], [55, 60], [73, 77], [89, 58], [66, 90], [84, 86], [46, 24], [90, 30], [2, 26], [70, 62], [14, 76]], '#668c9c')}
      ${speckle([[16, 20], [33, 5], [75, 16], [52, 34], [24, 62], [4, 78], [92, 70], [60, 72], [44, 92], [80, 50], [38, 70], [86, 94]], '#4b6f80')}
      <path d='M48.5 0v96M0 48.5h96' stroke='#4d7283' stroke-width='1'/>
    `)
  }
}

function skinCss(name, skin) {
  const night = 'linear-gradient(rgba(9,11,42,.52), rgba(9,11,42,.52))'
  const floor = `url("${skin.floor}") 0 ${WALL_H}px / ${skin.floorSize} repeat local`
  const wall = `url("${skin.wall}") 0 0 / ${skin.wallSize} repeat-x`

  return `
.office-room.is-${name} { background: ${floor}, ${skin.floorColor}; }
.office-room.is-${name} .office-wall { background: ${wall}, ${skin.wallColor}; }
.office-root.is-night .office-room.is-${name} { background: ${night} 0 0 / auto repeat local, ${floor}, ${skin.floorColor}; }
.office-root.is-night .office-room.is-${name} .office-wall { background: ${night}, ${wall}, ${skin.wallColor}; }`
}

const BOT_CHAT_TITLE = 'Bot Chat'
const focusedProfileState = host.state?.focusedSessionProfile || host.state.profile
const chatCreates = new Map()
const jobPollers = new Map()
let pluginCtx = null

function useTurnBusy() {
  return Boolean(useValue(host.state.busy))
}

function usePulse(ms = 200) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let id = 0
    let live = true

    if (ms <= 32 && typeof requestAnimationFrame === 'function') {
      const tick = () => {
        if (!live) {
          return
        }

        setNow(Date.now())
        id = requestAnimationFrame(tick)
      }

      id = requestAnimationFrame(tick)
      return () => {
        live = false
        cancelAnimationFrame(id)
      }
    }

    id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])

  return now
}

function useRoster() {
  return useQuery({
    queryKey: ROSTER_KEY,
    queryFn: () => host.request('profiles.list', {}),
    refetchInterval: 5000,
    staleTime: 5000,
    retry: true,
    retryDelay: attempt => Math.min(15000, 1000 * 2 ** attempt)
  })
}

function displayName(bot, meta) {
  if (meta?.title?.trim()) {
    return meta.title.trim()
  }

  if ((bot.name || '').trim().toLowerCase() === 'default' && !bot.title) {
    return 'Hermes'
  }

  const raw = (bot.title || bot.name || '').replace(/[-_]+/g, ' ').trim()
  return raw.replace(/\b\w/g, ch => ch.toUpperCase())
}

function botHandle(name) {
  return (name || '').trim().toLowerCase() === 'default' ? 'hermes' : name
}

function botMeta(bot) {
  const raw = bot?.ui_meta?.[META_NS]
  return raw && typeof raw === 'object' ? raw : {}
}

const $avatars = atom({})
const avatarInflight = new Set()

function pullAvatars(roster) {
  for (const bot of roster || []) {
    if (!bot.has_avatar || $avatars.get()[bot.name] || avatarInflight.has(bot.name)) {
      continue
    }

    avatarInflight.add(bot.name)
    host
      .request('profiles.get_asset', { name: bot.name, asset: 'avatar' })
      .then(res => {
        if (res?.found && res.data) {
          $avatars.set({ ...$avatars.get(), [bot.name]: res.data })
        }
      })
      .catch(() => undefined)
      .finally(() => avatarInflight.delete(bot.name))
  }
}

function botLook(bot) {
  const meta = botMeta(bot)
  const name = bot.name || 'agent'
  const isPrimary = name.trim().toLowerCase() === 'default'
  const color = meta.color || (isPrimary ? '#8b5cf6' : profileColor(name) || '#8b5cf6')
  const cached = $avatars.get()[name]

  return {
    color,
    image: typeof meta.image === 'string' ? meta.image : cached || null,
    title: displayName(bot, meta)
  }
}

function deskMood({ isActive, turnBusy, tasked }) {
  if (tasked || (isActive && turnBusy)) {
    return 'think'
  }

  return 'idle'
}

// Small stable number per name, for staggering blinks and the like.
function nameHash(name) {
  let h = 0
  for (const ch of String(name || '')) {
    h = (h * 31 + ch.charCodeAt(0)) % 100003
  }
  return h
}

// Type the screen text out one letter at a time once a bot starts thinking.
function typedText(text, elapsedMs, cps = 28) {
  const full = String(text || '')
  const n = Math.max(0, Math.floor((elapsedMs || 0) / (1000 / cps)))
  if (n >= full.length) {
    return full
  }
  return full.slice(0, n) + '\u258d'
}

function faceMood({ held, asleep, pet, clap, stretch, shy, peek, think, bored }) {
  if (held && asleep) {
    return 'sleep'
  }

  if (held) {
    return 'held'
  }

  if (asleep) {
    return 'sleep'
  }

  if (pet) {
    return 'pet'
  }

  if (clap) {
    return 'clap'
  }

  if (stretch) {
    return 'stretch'
  }

  if (shy) {
    return 'shy'
  }

  if (peek) {
    return 'peek'
  }

  if (think) {
    return 'think'
  }

  if (bored) {
    return 'bored'
  }

  return 'idle'
}

function movedEnough(a, b) {
  if (!a || !b) {
    return false
  }

  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy >= DRAG_PX * DRAG_PX
}

function near(a, b, r) {
  if (!a || !b) {
    return false
  }

  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy <= r * r
}

function isNightHour(date = new Date()) {
  const hour = date.getHours()
  return hour >= 19 || hour < 7
}

// One clock for everything that depends on the time of day. Night is the same
// window the room tint uses, so the sky can never disagree with the room.
// `t` runs 0..1 across the sun's arc (7am to 7pm) or the moon's (7pm to 7am).
function skyState(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60
  const night = isNightHour(date)
  const t = night ? (((h - 19 + 24) % 24) / 12) : ((h - 7) / 12)
  const dusk = !night && h >= 17.5
  const dawn = !night && h < 8.5
  return { night, t: Math.max(0, Math.min(1, t)), tone: night ? 'night' : dusk ? 'dusk' : dawn ? 'dawn' : 'day' }
}

function headerLine(names, one, many) {
  const list = (names || []).filter(Boolean)
  if (!list.length) {
    return ''
  }
  const shown = list.slice(0, 2).join(', ')
  const more = list.length > 2 ? ` +${list.length - 2}` : ''
  return `${shown}${more} ${list.length === 1 ? one : many}`
}

// Steady state labels fade after a moment so a full floor stays calm.
function quietStatus(text) {
  return text === '在岗' || text === '在工位' || text === '溜达'
}

// Which round a completion belongs to, or null if that round already
// celebrated. Rounds without a token (old state) count as round 0.
function completionToken(row) {
  const round = row?.round || 0
  return row?.doneRound === round ? null : round
}

// Pure task state transitions. Unknown terminal evidence is deliberately not
// treated as success. Completed and failed jobs are immutable: delayed frames
// from the same turn cannot reverse their terminal result.
function taskTransition(job, event) {
  if (!job || !event || (event.id && event.id !== job.id)) {
    return job
  }
  const terminal = job.state === JOB_STATES.COMPLETED || job.state === JOB_STATES.FAILED
  if (terminal) {
    return job
  }
  if (event.type === 'accepted') {
    return { ...job, state: JOB_STATES.RUNNING, acceptedAt: event.at || job.acceptedAt || Date.now() }
  }
  if (event.type === 'started') {
    return { ...job, state: JOB_STATES.RUNNING, startedAt: event.at || job.startedAt || Date.now() }
  }
  if (event.type === 'resumed' && event.runtimeSessionId) {
    return { ...job, runtimeSessionId: event.runtimeSessionId }
  }
  if (event.type === 'completed') {
    return { ...job, state: JOB_STATES.COMPLETED, completedAt: event.at || Date.now(), error: null }
  }
  if (event.type === 'failed') {
    return { ...job, state: JOB_STATES.FAILED, completedAt: event.at || Date.now(), error: String(event.error || '任务失败了。') }
  }
  if (event.type === 'unknown') {
    return { ...job, state: JOB_STATES.UNKNOWN, error: String(event.error || '无法确认任务状态。') }
  }
  return job
}

function jobIsActive(row) {
  // Keep this helper independent so pure movement tests can extract it from
  // the single-file runtime without booting the SDK.
  return Boolean(row && (row.state === 'submitting' || row.state === 'running' || typeof row.t0 === 'number'))
}

function jobAllowsSubmission(row) {
  return !jobIsActive(row)
}

function normalizeJobs(value) {
  if (!value || value.version !== JOBS_SCHEMA_VERSION) {
    return {}
  }
  const records = typeof value === 'object' && !Array.isArray(value) ? value.records : null
  if (!records || typeof records !== 'object' || Array.isArray(records)) {
    return {}
  }
  const next = {}
  for (const [name, row] of Object.entries(records)) {
    if (!name.trim() || !row || typeof row !== 'object' || !row.id || !row.storedSessionId || !row.profile) continue
    const state = Object.values(JOB_STATES).includes(row.state) ? row.state : JOB_STATES.UNKNOWN
    const route = row.route && typeof row.route.connectionId === 'string' && typeof row.route.profile === 'string'
      ? {
          connectionId: row.route.connectionId,
          mode: row.route.mode === 'local' ? 'local' : 'remote',
          profile: row.route.profile,
          targetProfile: typeof row.route.targetProfile === 'string' && row.route.targetProfile ? row.route.targetProfile : row.route.profile
        }
      : null
    next[name] = {
      ...row,
      id: String(row.id),
      profile: String(row.profile),
      connectionId: route?.connectionId || null,
      targetProfile: route?.targetProfile || String(row.targetProfile || row.profile),
      route,
      storedSessionId: String(row.storedSessionId),
      runtimeSessionId: row.runtimeSessionId ? String(row.runtimeSessionId) : null,
      submittedAt: Number.isFinite(row.submittedAt) ? row.submittedAt : Date.now(),
      state,
      prompt: String(row.prompt || '').slice(0, TASK_PROMPT_MAX),
      effectsApplied: Boolean(row.effectsApplied)
    }
  }
  return next
}

// A bot that has had no task for days, and is idle at its desk, is bored.
function isBored(lastTaskAt, now, thresholdMs = BORED_MS_SLICE) {
  if (!lastTaskAt) {
    return false
  }
  return (now || 0) - lastTaskAt > thresholdMs
}

// Monday 00:00 local for the week that contains `date`.
function weekStart(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const day = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - day)
  return d.getTime()
}

// Bump a weekly counter. Starts a fresh week when the Monday moved on.
function weekBump(stats, key, name, now) {
  const start = weekStart(new Date(now || Date.now()))
  const base = stats && stats.start === start ? stats : { start, tasks: 0, hops: 0, pizzas: {} }
  const next = { ...base, pizzas: { ...(base.pizzas || {}) } }

  if (key === 'pizza') {
    next.pizzas[name] = (next.pizzas[name] || 0) + 1
  } else if (key === 'tasks' || key === 'hops') {
    next[key] = (next[key] || 0) + 1
  }

  return next
}

// First of the month, local midnight.
function monthStart(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

function monthBump(stats, name, now) {
  const start = monthStart(new Date(now || Date.now()))
  const base = stats && stats.start === start ? stats : { start, tasks: {}, holder: null }
  const tasks = { ...(base.tasks || {}), [name]: ((base.tasks || {})[name] || 0) + 1 }
  const holder = monthLeader({ ...base, tasks }, base.holder)
  return { start, tasks, holder }
}

// Who has the most tasks this month. Ties keep the current holder, so a bot
// has to pass them, not just match them, to take the frame.
function monthLeader(stats, prevHolder) {
  const tasks = (stats && stats.tasks) || {}
  let best = null
  let bestN = 0

  for (const [name, n] of Object.entries(tasks)) {
    if (n > bestN || (n === bestN && name === prevHolder)) {
      best = name
      bestN = n
    }
  }

  return bestN > 0 ? best : null
}

function weekLine(stats) {
  if (!stats || (!stats.tasks && !stats.hops && !Object.keys(stats.pizzas || {}).length)) {
    return null
  }

  const bits = []
  if (stats.tasks) {
    bits.push(`${stats.tasks} 个任务`)
  }

  const eaters = Object.entries(stats.pizzas || {}).sort((a, b) => b[1] - a[1])
  if (eaters.length) {
    const [who, n] = eaters[0]
    bits.push(`${who === 'default' ? 'Hermes' : who} 吃了 ${n} 块披萨`)
  }

  if (stats.hops) {
    bits.push(`${stats.hops} 次跳`)
  }

  return `本周：${bits.join('，')}`
}

function clockLabel(date = new Date()) {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function clockHands(date = new Date()) {
  const h = date.getHours()
  const m = date.getMinutes()
  return {
    hour: (h % 12) * 30 + m * 0.5,
    minute: m * 6
  }
}

function nextClockKind(kind) {
  return kind === 'digital' ? 'analog' : 'digital'
}

function pickBotChatRow(rows, pinned) {
  const list = Array.isArray(rows) ? rows : []

  if (pinned && list.some(row => row && row.id === pinned)) {
    return pinned
  }

  const titled = list.find(row => (row?.title || '').trim() === BOT_CHAT_TITLE)

  if (titled?.id) {
    return titled.id
  }

  return null
}

function resolvePicked(roster, selected, activeProfile) {
  const name = selected || activeProfile

  if (name && roster.some(bot => bot.name === name)) {
    return name
  }

  return roster[0]?.name || null
}

function savePref(key, value) {
  try {
    // PluginStorage is synchronous. Keeping this write synchronous means a
    // preference changed immediately after registration cannot be overwritten
    // by a late hydration callback.
    pluginCtx?.storage?.set?.(key, value)
  } catch {
    /* no storage */
  }
}

// ── routed bot SDK seam ─────────────────────────────────────────────────────
// Session RPCs must follow the selected bot's owner, not the focused chat.
// Routes are optional on older single-gateway hosts; in that topology the
// profile-only requestProfile overload remains the safe compatibility path.
const botRouteCache = new Map()

function pickBotRoute(routes, name, connectionId) {
  const candidates = (Array.isArray(routes) ? routes : []).filter(
    row => row && (row.profile === name || row.targetProfile === name)
  )
  if (connectionId) {
    const owned = candidates.filter(row => row.connectionId === connectionId)
    if (owned.length === 1) return owned[0]
    if (owned.length > 1) throw new Error(`Bot ${name} has more than one route on ${connectionId}`)
    return null
  }
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) throw new Error(`Bot ${name} has more than one connection owner`)
  return null
}

async function botOwnerRoute(bot) {
  const name = String(bot?.name || '').trim()
  if (!name) return null
  if (bot?.route?.connectionId && bot.route.profile) return bot.route
  const connectionId = String(
    bot?.connectionId || host.state?.connectionId?.get?.() || host.activeConnectionId?.() || ''
  ).trim()
  const cacheKey = `${connectionId || 'legacy'}::${name}`
  if (botRouteCache.has(cacheKey)) return botRouteCache.get(cacheKey)
  if (typeof host.profileRoutes !== 'function') return null

  let routes
  try {
    routes = await host.profileRoutes()
  } catch (error) {
    throw new Error(`Could not resolve ${name}'s connection owner: ${String(error?.message || error)}`)
  }
  const route = pickBotRoute(routes, name, connectionId)
  if (!route && Array.isArray(routes) && routes.length) {
    throw new Error(`Could not resolve ${name}'s connection owner`)
  }
  if (route) botRouteCache.set(cacheKey, route)
  return route
}

async function requestForBot(bot, method, params = {}) {
  const name = String(bot?.name || '').trim()
  if (!name) throw new Error(`Cannot route ${method}: bot name is missing`)
  const route = await botOwnerRoute(bot)
  const payload = { ...params }
  if (route?.targetProfile && Object.prototype.hasOwnProperty.call(payload, 'profile')) {
    payload.profile = route.targetProfile
  }
  if (route?.targetProfile && method.startsWith('profiles.') && method !== 'profiles.create' && payload.name === name) {
    payload.name = route.targetProfile
  }
  if (route && typeof host.requestProfile === 'function') {
    try {
      return await host.requestProfile(route, method, payload)
    } catch (error) {
      // A connection can be removed or remapped while the Office is open.
      // Forget cached ownership for the next user action, but never retry an
      // in-flight mutation such as prompt.submit automatically.
      botRouteCache.clear()
      throw error
    }
  }
  if (typeof host.requestProfile === 'function' && typeof host.profileRoutes !== 'function') {
    // Legacy sole-local overload. Registry-aware hosts must resolve an exact
    // descriptor above; profile names alone are ambiguous across sources.
    return host.requestProfile(name, method, payload)
  }
  const active = String(host.state?.profile?.get?.() || '').trim()
  if (active && active !== name) {
    throw new Error(`Cannot route ${method} for ${name}: this Desktop has no owner-scoped request API`)
  }
  return host.request(method, { ...payload, profile: name })
}

async function withBotLease(bot, run) {
  const route = await botOwnerRoute(bot)
  let release = () => undefined
  if (route && typeof host.retainProfile === 'function') {
    release = await host.retainProfile(route)
  }
  try {
    return await run(route)
  } finally {
    release()
  }
}

function outputText(bot) {
  return (bot.last_session?.preview || '').trim()
}

function previewLine(bot) {
  const text = outputText(bot)
  if (!text) {
    return '等待任务'
  }
  return text.length > 72 ? `${text.slice(0, 71)}…` : text
}

function stickyText(bot) {
  const text = (bot.last_session?.preview || '').trim()
  if (!text) {
    return ''
  }
  return text.length > 20 ? `${text.slice(0, 19)}…` : text
}

function easeInOut(t) {
  const x = Math.max(0, Math.min(1, t))
  return x < 0.5 ? 2 * x * x : 1 - (2 - 2 * x) * (2 - 2 * x) / 2
}

function roamMs(from, to) {
  if (!from || !to) {
    return 2000
  }

  const dx = to.x - from.x
  const dy = to.y - from.y
  return Math.max(1400, Math.min(4200, Math.sqrt(dx * dx + dy * dy) * 18))
}

function backdropNames() {
  return ['carpet']
}

function nextBackdrop(kind) {
  const all = backdropNames()
  const i = all.indexOf(kind)
  return all[((i < 0 ? 0 : i) + 1) % all.length]
}

function idleBotNames(roster, jobs, activeProfile, turnBusy) {
  return (Array.isArray(roster) ? roster : [])
    .filter(
      bot =>
        deskMood({
          isActive: bot.name === activeProfile,
          turnBusy,
          tasked: jobIsActive(jobs && jobs[bot.name])
        }) === 'idle'
    )
    .map(bot => bot.name)
}

const FACE_HALF = 21
const HOP_ROWS = [[1], [2], [3, 4], [5], [6, 7], [8]]
const BORED_MS_SLICE = 2 * 24 * 60 * 60 * 1000

// Out along the rows, turn at the end, and hop back down.
function hopCourse(rows) {
  const out = Array.isArray(rows) ? rows : []
  if (out.length < 2) {
    return out.slice()
  }

  return out.concat(out.slice(0, -1).reverse())
}

function chairCountForGame(playerCount) {
  return Math.max(0, (playerCount || 0) - 1)
}

function pickFreeStool(stools, taken, radius = 40) {
  const seats = Array.isArray(stools) ? stools : []
  const used = Array.isArray(taken) ? taken : []

  if (!seats.length) {
    return null
  }

  return seats.find(stool => !used.some(spot => near(stool, spot, radius))) || null
}

function nextBarStand(stools, taken, radius = 40) {
  const free = pickFreeStool(stools, taken, radius)
  if (free) {
    return free
  }

  const seats = Array.isArray(stools) ? stools : []
  const last = seats[seats.length - 1]

  if (!last) {
    return null
  }

  const n = (Array.isArray(taken) ? taken : []).length
  return { id: `stand-${n}`, x: last.x - 20, y: last.y + 18 }
}

// Pizza parlor rule: one pizza on the counter per round. A round starts when
// anyone is given a task. The first bot to finish and reach the counter takes
// the slice, everyone after that gets "no pizza".
function freshPizza(now) {
  return { winner: null, at: now }
}

function claimPizza(pizza, name, now) {
  const current = pizza || freshPizza(now)

  if (current.winner) {
    return { pizza: current, won: current.winner === name }
  }

  return { pizza: { winner: name, at: now }, won: true }
}

const CHAIR_PX = 30

// Musical chairs live in the middle of the box, backs together in a small ring.
// Positions are the chair's top-left; `gameRing` says how far out the players circle.
function boxCenter(box) {
  const area = box || { x0: 12, y0: 92, x1: 360, y1: 280 }
  return { x: (area.x0 + area.x1) / 2, y: (area.y0 + area.y1) / 2 }
}

function chairRingRadius(count) {
  return count <= 1 ? 0 : count === 2 ? 22 : 18 + count * 5
}

function placeChairs(n, box) {
  const count = Math.max(0, n || 0)
  const center = boxCenter(box)
  const radius = chairRingRadius(count)
  const chairs = []

  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (i / Math.max(1, count)) * Math.PI * 2
    chairs.push({
      id: `c${i}`,
      x: Math.round(center.x + Math.cos(angle) * radius - CHAIR_PX / 2),
      y: Math.round(center.y + Math.sin(angle) * radius - CHAIR_PX / 2)
    })
  }

  return chairs
}

// Where the players walk while the music plays: a wider ring around the chairs.
function gameRing(box, count) {
  const center = boxCenter(box)
  const area = box || { x0: 12, y0: 92, x1: 360, y1: 280 }
  const room = Math.min((area.x1 - area.x0) / 2, (area.y1 - area.y0) / 2) - 26
  const radius = Math.max(56, Math.min(chairRingRadius(count) + 84, room))
  return { center, radius }
}

// Next stop on the ring: keep going clockwise from wherever the player is now.
function ringPoint(ring, from, step = 0.9) {
  const dx = (from?.x ?? ring.center.x) + FACE_HALF - ring.center.x
  const dy = (from?.y ?? ring.center.y) + FACE_HALF - ring.center.y
  const angle = Math.atan2(dy, dx) + step
  return {
    x: ring.center.x + Math.cos(angle) * ring.radius - FACE_HALF,
    y: ring.center.y + Math.sin(angle) * ring.radius - FACE_HALF
  }
}

function assignChairs(players, chairs) {
  const people = Array.isArray(players) ? players : []
  const seats = Array.isArray(chairs) ? chairs : []
  const pairs = []

  for (const person of people) {
    for (const chair of seats) {
      const dx = (person.x || 0) - (chair.x || 0)
      const dy = (person.y || 0) - (chair.y || 0)
      pairs.push({ name: person.name, chair, d: dx * dx + dy * dy })
    }
  }

  pairs.sort((a, b) => a.d - b.d)

  const assigned = {}
  const usedP = new Set()
  const usedC = new Set()

  for (const pair of pairs) {
    if (usedP.has(pair.name) || usedC.has(pair.chair.id)) {
      continue
    }

    assigned[pair.name] = pair.chair
    usedP.add(pair.name)
    usedC.add(pair.chair.id)

    if (usedC.size === seats.length) {
      break
    }
  }

  const leftover = people.map(p => p.name).find(name => !usedP.has(name)) || null
  return { assigned, leftover }
}

function beginWalk(from, to, now, kind, path) {
  const scale = kind === 'chair' ? 0.55 : kind === 'bar' ? 0.68 : 0.72
  const dist = Math.hypot((to?.x || 0) - (from?.x || 0), (to?.y || 0) - (from?.y || 0))
  const ms = kind === 'hopscotch'
    ? Math.max(360, Math.min(1400, dist * 9))
    : Math.max(420, roamMs(from, to) * scale)
  return {
    from,
    to,
    t0: now || 0,
    ms,
    kind: kind || 'home',
    path: Array.isArray(path) ? path : []
  }
}

function advanceWalk(walk, now) {
  if (!walk) {
    return { walk: null, done: true, arrived: false }
  }

  if ((now || 0) - walk.t0 < walk.ms) {
    return { walk, done: false, arrived: false }
  }

  if (walk.path && walk.path.length) {
    const next = walk.path[0]
    return {
      walk: beginWalk(walk.to, next, now, walk.kind, walk.path.slice(1)),
      done: false,
      arrived: false
    }
  }

  return { walk: null, done: true, arrived: true, at: walk.to, kind: walk.kind }
}

function walkHop(raw, kind) {
  const t = Math.max(0, Math.min(1, raw))
  if (t >= 1 || (typeof reducedMotion === 'function' && reducedMotion())) {
    return 0
  }

  if (kind === 'hopscotch') {
    return 4 * t * (1 - t) * 16
  }

  if (kind === 'home' || kind === 'chair' || kind === 'bar') {
    return Math.abs(Math.sin(t * Math.PI * 2)) * 7
  }

  return Math.abs(Math.sin(t * Math.PI * 3)) * 6
}

// Travel easing per walk kind. Hops move at a steady speed so the arc reads
// as a jump. Everything else eases in and out like a stroll.
function walkEase(raw, kind) {
  const t = Math.max(0, Math.min(1, raw))
  return kind === 'hopscotch' ? t : easeInOut(t)
}

// Squash on landing, stretch on take off. Returns x/y scale for the sprite.
function hopSquash(raw, kind) {
  const t = Math.max(0, Math.min(1, raw))
  if (kind !== 'hopscotch' || (typeof reducedMotion === 'function' && reducedMotion())) {
    return { sx: 1, sy: 1 }
  }

  if (t < 0.14) {
    const k = 1 - t / 0.14
    return { sx: 1 + 0.14 * k, sy: 1 - 0.16 * k }
  }

  if (t < 0.34) {
    const k = Math.sin(((t - 0.14) / 0.2) * Math.PI)
    return { sx: 1 - 0.06 * k, sy: 1 + 0.1 * k }
  }

  if (t > 0.9) {
    const k = (t - 0.9) / 0.1
    return { sx: 1 + 0.14 * k, sy: 1 - 0.16 * k }
  }

  return { sx: 1, sy: 1 }
}

function roamBox(roomEl) {
  if (!roomEl) {
    return { x0: 12, y0: 92, x1: 360, y1: 280 }
  }

  const box = roomEl.getBoundingClientRect()
  return {
    x0: 12,
    y0: 92,
    x1: Math.max(80, box.width - 52),
    y1: Math.max(160, box.height - 52)
  }
}

function roamPoint(roomEl, avoid) {
  const box = roamBox(roomEl)
  const pick = () => ({
    x: box.x0 + Math.random() * (box.x1 - box.x0),
    y: box.y0 + Math.random() * (box.y1 - box.y0)
  })
  let next = pick()

  if (avoid && near(next, avoid, 48)) {
    next = pick()
  }

  return next
}

function setRoam(name, from, roomEl) {
  const to = roamPoint(roomEl, from)
  $roam.set({
    ...$roam.get(),
    [name]: { from, to, t0: Date.now(), ms: roamMs(from, to), rest: 500 + Math.random() * 700 }
  })
}

function clearRoam(name) {
  const next = { ...$roam.get() }

  if (!(name in next)) {
    return
  }

  delete next[name]
  $roam.set(next)
}

function tickRoam(now, roomEl, opts = {}) {
  if (!roomEl) {
    return
  }

  const seats = $seats.get()
  const drag = $drag.get()
  const walks = $walks.get()
  const roam = $roam.get()
  const jobs = opts.jobs || $jobs.get()
  const game = $game.get()
  const players = new Set(game?.players || [])
  const nextRoam = { ...roam }
  const nextSeats = { ...seats }
  let seatsDirty = false
  let roamDirty = false
  const scramble = opts.scramble || false
  const only = opts.only ? new Set(opts.only) : null
  const rosterNames = opts.rosterNames ? new Set(opts.rosterNames) : null

  for (const name of Object.keys(seats)) {
    if ((rosterNames && !rosterNames.has(name)) || (only && !only.has(name))) {
      continue
    }

    if (drag?.name === name || walks[name]) {
      continue
    }

    if (!scramble && (jobIsActive(jobs[name]) || players.has(name))) {
      continue
    }

    const fx = $fx.get()[name] || {}
    if (!scramble && (fx.lingerUntil || 0) > now) {
      continue
    }

    const leg = roam[name]
    const rest = scramble ? 60 : leg?.rest || 0

    if (leg && now - leg.t0 < leg.ms + rest) {
      continue
    }

    const from = leg ? leg.to : seats[name]
    const to = scramble && opts.ring ? ringPoint(opts.ring, from) : roamPoint(roomEl, from)
    const ms = scramble ? Math.max(420, roamMs(from, to) * 0.42) : roamMs(from, to)
    nextRoam[name] = { from, to, t0: now, ms, rest: scramble ? 60 + Math.random() * 80 : 500 + Math.random() * 700 }
    roamDirty = true

    if (leg) {
      nextSeats[name] = from
      seatsDirty = true
    }
  }

  for (const name of Object.keys(nextRoam)) {
    if ((rosterNames && !rosterNames.has(name)) || (!nextSeats[name] && drag?.name !== name)) {
      delete nextRoam[name]
      roamDirty = true
    }
  }

  if (roamDirty) {
    $roam.set(nextRoam)
  }

  if (seatsDirty) {
    saveSeats(nextSeats)
  }
}

function pointInRoom(roomEl, clientX, clientY) {
  if (!roomEl) {
    return { x: clientX, y: clientY }
  }

  const box = roomEl.getBoundingClientRect()
  return {
    x: Math.max(12, Math.min(box.width - 52, clientX - box.left - 21)),
    y: Math.max(92, Math.min(box.height - 52, clientY - box.top - 24))
  }
}

function pointOnWall(roomEl, clientX, clientY) {
  if (!roomEl) {
    return { x: clientX, y: clientY }
  }

  const box = roomEl.getBoundingClientRect()
  return {
    x: Math.max(8, Math.min(box.width - 72, clientX - box.left - 26)),
    y: Math.max(8, Math.min(box.height - 52, clientY - box.top - 18))
  }
}

function saveSeats(next) {
  $seats.set(next)

  try {
    Promise.resolve(pluginCtx?.storage?.set?.('seats', next)).catch(() => undefined)
  } catch {
    /* no storage on this shell */
  }
}

function patchFx(name, patch) {
  $fx.set({ ...$fx.get(), [name]: { ...($fx.get()[name] || {}), ...patch } })
}

function readFx(name, now) {
  const row = $fx.get()[name] || {}
  const lingering = (row.lingerUntil || 0) > now
  return {
    nap: Boolean(row.nap),
    clap: (row.clapUntil || 0) > now,
    stretch: (row.stretchUntil || 0) > now,
    closer: (row.closerUntil || 0) > now,
    whisper: (row.whisperUntil || 0) > now,
    cheers: Boolean(row.atBar) && lingering,
    pizza: (row.pizzaUntil || 0) > now,
    noPizza: (row.noPizzaUntil || 0) > now,
    drop: (row.dropUntil || 0) > now,
    boot: (row.bootUntil || 0) > now,
    hi: (row.hiUntil || 0) > now,
    ritual: (row.ritualUntil || 0) > now,
    ask: (row.askUntil || 0) > now,
    bang: (row.bangUntil || 0) > now,
    petted: (row.petUntil || 0) > now,
    confetti: (row.confettiUntil || 0) > now,
    five: (row.fiveUntil || 0) > now,
    yawn: (row.yawnUntil || 0) > now,
    thinkSince: row.thinkSince || 0,
    goHome: Boolean(row.goHome),
    goBar: Boolean(row.goBar)
  }
}

function tap() {
  try {
    haptic('tap')
  } catch {
    /* older shell */
  }
}

function pickBot(name) {
  $selected.set(name)
  $focusTask.set(Date.now())

  try {
    if (typeof host.warmProfile === 'function') {
      host.warmProfile(name)
    }
  } catch {
    /* older shell */
  }
}

function saveChatPin(bot, chat) {
  const meta = { ...botMeta(bot) }

  if (chat) {
    meta.chat = chat
  } else {
    delete meta.chat
  }

  const { image, pet, ...rest } = meta

  try {
    Promise.resolve(
      requestForBot(bot, 'profiles.configure', { name: bot.name, ui_meta: { [META_NS]: rest } })
    ).catch(() => undefined)
  } catch {
    /* older gateway */
  }
}

async function resumeBotChat(bot, id) {
  const res = await requestForBot(bot, 'session.resume', {
    session_id: id,
    profile: bot.name,
    omit_messages: true
  })

  if (!res?.session_id) {
    return null
  }

  return {
    runtime: res.session_id,
    stored: res.session_key || id
  }
}

async function createBotChat(bot) {
  const res = await requestForBot(bot, 'session.create', {
    profile: bot.name,
    title: BOT_CHAT_TITLE,
    hidden: true,
    follow_profile_config: true
  })
  const stored = res?.stored_session_id || null
  const runtime = res?.session_id || null

  if (runtime) {
    try {
      await requestForBot(bot, 'session.title', { session_id: runtime, title: BOT_CHAT_TITLE })
    } catch (error) {
      // Older gateways may not expose eager titling. The first accepted prompt
      // still materializes the requested title; never hide a real create error.
      if (!/method not found|unknown method|unsupported/i.test(String(error?.message || error))) throw error
    }
  }
  if (stored) saveChatPin(bot, stored)
  return { runtime, stored, created: true }
}

async function ensureBotChat(bot) {
  const name = bot.name
  const inflight = chatCreates.get(name)
  if (inflight) return inflight

  const run = (async () => {
    const pinned = botMeta(bot).chat
    const canonical = bot.canonical_session
    // The roster's canonical_session is server-resolved identity. Compression
    // tips are the runtime-open target while the root remains the registry id.
    if (canonical?.id) {
      const live = await resumeBotChat(bot, canonical.resolved_id || canonical.id)
      if (live) return { ...live, created: false }
    }
    // A legacy pin is only a hint; it never authorizes a chat by itself. The
    // exact hidden title lookup below is the source of truth.

    let listed
    try {
      listed = await requestForBot(bot, 'session.list', {
        profile: bot.name,
        title: BOT_CHAT_TITLE,
        include_hidden: true,
        limit: 100
      })
    } catch (error) {
      // Never interpret an unavailable registry as an absent Bot Chat.
      throw new Error(`无法检查 ${name} 的 Bot 聊天注册表：${String(error?.message || error)}`)
    }

    const rows = Array.isArray(listed?.sessions) ? listed.sessions : []
    const titled = rows.find(row => (row?.title || '').trim() === BOT_CHAT_TITLE)
    const id = titled?.resolved_id || titled?.id || null
    if (id) {
      if (titled.id && titled.id !== pinned) saveChatPin(bot, titled.id)
      const live = await resumeBotChat(bot, id)
      if (live) return { ...live, created: false }
    }

    return createBotChat(bot)
  })().finally(() => chatCreates.delete(name))
  chatCreates.set(name, run)
  return run
}

function saveJobs(records = $jobs.get()) {
  savePref(JOBS_STORAGE_KEY, { version: JOBS_SCHEMA_VERSION, records })
}

function currentJob(name, id) {
  const row = $jobs.get()[name]
  return row && (!id || row.id === id) ? row : null
}

function updateJob(name, id, event) {
  const current = currentJob(name, id)
  if (!current) return null
  const next = taskTransition(current, event)
  if (next === current) return current
  if (!jobIsActive(next)) clearOfficeInput(name)
  $jobs.set({ ...$jobs.get(), [name]: next })
  saveJobs()
  return next
}

function markJob(bot, chat, prompt, route) {
  const name = bot.name
  const id = `office-${Date.now()}-${++jobSequence}`
  const row = {
    id,
    generation: jobSequence,
    profile: name,
    connectionId: route?.connectionId || bot.connectionId || null,
    targetProfile: route?.targetProfile || route?.profile || name,
    route: route || null,
    storedSessionId: chat.stored || null,
    runtimeSessionId: chat.runtime || null,
    prompt: String(prompt || '').slice(0, TASK_PROMPT_MAX),
    submittedAt: Date.now(),
    state: JOB_STATES.SUBMITTING,
    error: null,
    effectsApplied: false,
    round: id
  }
  $jobs.set({ ...$jobs.get(), [name]: row })
  return row
}

function clearJob(name, id) {
  const current = currentJob(name, id)
  if (!current) return
  const next = { ...$jobs.get() }
  delete next[name]
  $jobs.set(next)
  saveJobs(next)
  const timer = jobPollers.get(name)
  if (timer && (!id || timer.id === id)) {
    clearInterval(timer.timer || timer)
    jobPollers.delete(name)
  }
}

function finishJob(name, id, event) {
  const row = updateJob(name, id, event)
  if (!row || row.state !== JOB_STATES.COMPLETED || row.effectsApplied) return
  clearOfficeInput(name)
  const next = { ...row, effectsApplied: true }
  $jobs.set({ ...$jobs.get(), [name]: next })
  saveJobs()
  const poll = jobPollers.get(name)
  if (poll?.id === id) {
    clearInterval(poll.timer)
    jobPollers.delete(name)
  }
  celebrate(name, row.route)
}

function handleJobEvent(event) {
  const sid = event?.session_id
  if (!sid) return
  for (const [name, row] of Object.entries($jobs.get())) {
    if (row.runtimeSessionId !== sid) continue
    if (row.connectionId && event.connectionId && row.connectionId !== event.connectionId) continue
    if (row.targetProfile && event.profile && row.targetProfile !== event.profile) continue
    handleOfficeInput(name, row, event)
    if (event.type === 'message.start') {
      updateJob(name, row.id, { type: 'started' })
    } else if (event.type === 'message.complete') {
      const failure = event.payload?.status === 'error'
      if (failure) {
        updateJob(name, row.id, { type: 'failed', error: event.payload?.error || '任务失败了。' })
        const poll = jobPollers.get(name)
        if (poll?.id === row.id) {
          clearInterval(poll.timer)
          jobPollers.delete(name)
        }
      } else finishJob(name, row.id, { type: 'completed' })
    }
  }
}

function watchJob(name, id) {
  if (jobPollers.has(name)) return
  const timer = setInterval(async () => {
    const row = currentJob(name, id)
    if (!row) return
    const age = Date.now() - (row.submittedAt || Date.now())
    if (age > 10 * 60 * 1000) {
      updateJob(name, id, { type: 'unknown', error: '任务十分钟后仍未解决。' })
      clearInterval(timer)
      jobPollers.delete(name)
      return
    }
    if (age < 1200) return
    try {
      const state = await requestForBot({ name, route: row.route, connectionId: row.connectionId }, 'session.resume', {
        session_id: row.storedSessionId || row.runtimeSessionId,
        profile: name,
        omit_messages: true
      })
      if (currentJob(name, id) !== row) return
      if (state?.session_id && state.session_id !== row.runtimeSessionId) {
        updateJob(name, id, { type: 'resumed', runtimeSessionId: state.session_id })
      }
      if (state?.inflight?.error) {
        updateJob(name, id, { type: 'failed', error: state.inflight.error })
        clearInterval(timer)
        jobPollers.delete(name)
      } else if (state?.running === true || state?.inflight) {
        updateJob(name, id, { type: 'started' })
      } else if (state && state.running === false && state.status === 'idle') {
        // Current gateways expose this pair only for a settled turn. Older or
        // partial response shapes remain unresolved instead of earning effects.
        finishJob(name, id, { type: 'completed' })
      }
    } catch { /* event stream or next poll can recover */ }
  }, 1600)
  jobPollers.set(name, { id, timer })
}

async function openBot(bot) {
  tap()
  const openId = ++openSequence
  try {
    return await withBotLease(bot, async route => {
      const chat = await ensureBotChat(bot)
      const id = chat?.stored
      if (!id || typeof host.openSession !== 'function') throw new Error('此桌面端无法打开已存储的 Bot 聊天')
      if (openId !== openSequence) return false
      await host.openSession(id, { profile: bot.name, ...(route ? { route } : {}) })
      if (openId === openSequence) readNote(bot.name)
      return true
    })
  } catch (error) {
    try { host.notifyError(error, `无法打开 ${botLook(bot).title} 的 Bot 聊天`) } catch { /* older shell */ }
    return false
  }
}

async function sendTask(bot, text) {
  const task = (text || '').trim()
  if (!task || !jobAllowsSubmission(currentJob(bot.name))) return false
  return withBotLease(bot, async route => {
    const chat = await ensureBotChat(bot)
    if (!chat?.runtime) throw new Error('无法打开该机器人的聊天')
    const row = markJob(bot, chat, task, route)
    try {
      await requestForBot(bot, 'prompt.submit', { session_id: chat.runtime, text: task })
      updateJob(bot.name, row.id, { type: 'accepted' })
      startRound(bot.name, row.id)
    } catch (error) {
      updateJob(bot.name, row.id, { type: 'failed', error: error?.message || '无法发送任务。' })
      patchFx(bot.name, { goHome: false })
      throw error
    }
    watchJob(bot.name, row.id)
    return true
  })
}

function dropBot(name, next, roomEl) {
  const now = Date.now()
  const others = Object.entries($seats.get()).filter(([key]) => key !== name)
  const seats = { ...$seats.get(), [name]: next }
  patchFx(name, { dropUntil: now + 460 })
  puffAt(next.x + FACE_HALF, next.y + FACE_HALF * 2)

  for (const [other, pos] of others) {
    if (near(next, pos, 70)) {
      patchFx(name, { whisperUntil: now + 2800 })
      patchFx(other, { whisperUntil: now + 2800 })
    }
  }

  $drag.set(null)
  patchFx(name, { atBar: false, lingerUntil: 0 })
  saveSeats(seats)
  if (!$jobs.get()[name] && !$game.get()?.players?.includes(name)) {
    setRoam(name, next, roomEl)
  }
}

function roamPos(leg, now = Date.now()) {
  if (!leg) {
    return null
  }

  const t = Math.min(1, (now - leg.t0) / Math.max(1, leg.ms))
  return {
    x: leg.from.x + (leg.to.x - leg.from.x) * t,
    y: leg.from.y + (leg.to.y - leg.from.y) * t
  }
}

function elPos(roomEl, el) {
  if (!roomEl || !el) {
    return null
  }

  const room = roomEl.getBoundingClientRect()
  const box = el.getBoundingClientRect()
  return {
    x: box.left - room.left + roomEl.scrollLeft,
    y: box.top - room.top + roomEl.scrollTop
  }
}

// Seat coords are the top-left of a 42px face. Anchor a walker on an element
// by centring the face on it horizontally; `lift` raises it so a body can
// overlap a stool or chair instead of standing on its top edge.
function faceOn(roomEl, el, lift = 0) {
  const pos = elPos(roomEl, el)
  if (!pos) {
    return null
  }

  const box = el.getBoundingClientRect()
  return {
    x: pos.x + box.width / 2 - FACE_HALF,
    y: pos.y + box.height / 2 - FACE_HALF - lift
  }
}

function deskPersonPos(name, roomEl) {
  const desk = roomEl?.querySelector(`[data-desk=${JSON.stringify(name)}]`)
  const slot = desk?.querySelector('.office-person .office-face') || desk?.querySelector('.office-desk-chair') || desk
  return faceOn(roomEl, slot)
}

function currentPos(name, roomEl, now = Date.now()) {
  const drag = $drag.get()
  if (drag?.name === name) {
    return { x: drag.x, y: drag.y }
  }

  const walk = $walks.get()[name]
  if (walk) {
    return roamPos(walk, now)
  }

  const roam = $roam.get()[name]
  if (roam) {
    return roamPos(roam, now)
  }

  return $seats.get()[name] || deskPersonPos(name, roomEl)
}

function setWalk(name, walk) {
  const next = { ...$walks.get() }

  if (walk) {
    next[name] = walk
  } else {
    delete next[name]
  }

  $walks.set(next)
}

function startWalk(name, to, roomEl, kind, path) {
  const from = currentPos(name, roomEl)
  clearRoam(name)

  if (!from || !to) {
    return false
  }

  if ($drag.get()?.name === name) {
    $drag.set(null)
  }

  const seats = { ...$seats.get(), [name]: from }
  saveSeats(seats)
  setWalk(name, beginWalk(from, to, Date.now(), kind, path))
  return true
}

function startWalkHome(name, roomEl) {
  if (!$seats.get()[name] && !$walks.get()[name] && $drag.get()?.name !== name) {
    patchFx(name, { atBar: false, lingerUntil: 0, goHome: false })
    return
  }

  const from = currentPos(name, roomEl)
  clearRoam(name)
  patchFx(name, { atBar: false, lingerUntil: 0, goHome: false })

  if (!from || !roomEl) {
    const next = { ...$seats.get() }
    delete next[name]
    saveSeats(next)
    setWalk(name, null)
    return
  }

  const desk = roomEl.querySelector(`[data-desk=${JSON.stringify(name)}]`)
  const slot = desk?.querySelector('.office-desk-chair') || desk
  if (!slot) {
    const next = { ...$seats.get() }
    delete next[name]
    saveSeats(next)
    setWalk(name, null)
    return
  }

  startWalk(name, faceOn(roomEl, slot), roomEl, 'home')
}

function stoolPoints(roomEl) {
  if (!roomEl) {
    return []
  }

  const els = roomEl.querySelectorAll('[data-stool]')
  const points = [...els].map((el, i) => {
    const pos = faceOn(roomEl, el, 12)
    return pos ? { id: el.getAttribute('data-stool') || String(i), ...pos } : null
  }).filter(Boolean)

  if (points.length) {
    return points
  }

  const box = roomEl.getBoundingClientRect()
  return [0, 1, 2].map(i => ({
    id: String(i),
    x: Math.max(80, box.width - 92),
    y: 118 + i * 52
  }))
}

function takenBarPoints() {
  const now = Date.now()
  const taken = []

  for (const [name, seat] of Object.entries($seats.get())) {
    const row = $fx.get()[name] || {}
    if ((row.lingerUntil || 0) > now) {
      taken.push(seat)
    }
  }

  for (const walk of Object.values($walks.get())) {
    if (walk.kind === 'bar' && walk.to) {
      taken.push(walk.to)
    }
  }

  return taken
}

function startWalkToBar(name, roomEl) {
  const existing = $walks.get()[name]
  if (existing?.kind === 'bar') {
    return
  }

  const fx = $fx.get()[name] || {}
  if (fx.atBar && (fx.lingerUntil || 0) > Date.now()) {
    return
  }

  const dest = nextBarStand(stoolPoints(roomEl), takenBarPoints())
  if (!dest) {
    return
  }

  startWalk(name, dest, roomEl, 'bar')
}

// The course: one landing per row (pairs are landed on together), out to the
// far end and back again. Each point carries the square ids it covers so the
// chalk can light up under the hopper.
function hopscotchPoints(roomEl) {
  if (!roomEl) {
    return []
  }

  const rows = HOP_ROWS.map(row => {
    const spots = row
      .map(n => roomEl.querySelector('[data-hop="' + n + '"]'))
      .map(el => faceOn(roomEl, el))
      .filter(Boolean)
    if (!spots.length) {
      return null
    }

    return {
      id: row.join('-'),
      x: spots.reduce((sum, p) => sum + p.x, 0) / spots.length,
      y: spots.reduce((sum, p) => sum + p.y, 0) / spots.length
    }
  }).filter(Boolean)

  return hopCourse(rows)
}

function startHopscotch(name, roomEl) {
  if (!name || $jobs.get()[name] || $game.get()) {
    return
  }

  const points = hopscotchPoints(roomEl)
  if (points.length < 2) {
    return
  }

  const [first, ...rest] = points
  startWalk(name, first, roomEl, 'hopscotch', rest)
  bumpWeek('hops', name)
}

// Someone got a task: they walk home, and a fresh pizza lands on the counter.
function startRound(name, roundToken = null) {
  const now = Date.now()
  patchFx(name, { round: roundToken || `${now}-${++jobSequence}`, nap: false, goHome: true, goBar: false, atBar: false, lingerUntil: 0, pizzaUntil: 0, noPizzaUntil: 0, thinkSince: now, bootUntil: now + 700, askUntil: now + 1400 })
  const last = { ...$lastTask.get(), [name]: now }
  $lastTask.set(last)
  savePref('lastTask', last)
  readNote(name)
  advanceHint('wait')
  $pizza.set(freshPizza(Date.now()))
}

function finishWalk(name, walk) {
  const seats = { ...$seats.get() }

  if (walk.kind === 'home') {
    delete seats[name]
    saveSeats(seats)
    return
  }

  if (walk.to) {
    seats[name] = walk.to
    saveSeats(seats)
  }

  if (walk.kind === 'bar') {
    const now = Date.now()
    patchFx(name, { atBar: true, lingerUntil: now + 4200, clapUntil: now + 1100, nap: false })

    const buddy = Object.entries($fx.get()).find(([other, row]) => other !== name && row.atBar && (row.lingerUntil || 0) > now)
    if (buddy) {
      patchFx(name, { fiveUntil: now + 1500 })
      patchFx(buddy[0], { fiveUntil: now + 1500, clapUntil: now + 900, lingerUntil: Math.max(buddy[1].lingerUntil || 0, now + 1800) })
    }

    {
      const { pizza, won } = claimPizza($pizza.get(), name, now)
      $pizza.set(pizza)
      if (won && pizza.winner === name && !(pizza.counted || {})[name]) {
        bumpWeek('pizza', name)
        rememberOffice('pizza', `${displayName({ name }, {})} 抢到了第一块披萨。`, [name])
        pizza.counted = { ...(pizza.counted || {}), [name]: true }
      }
      patchFx(name, won ? { pizzaUntil: now + PIZZA_MS, lingerUntil: now + 6000 } : { noPizzaUntil: now + 4200 })
    }
  }
}

// Two bots crossing paths say hi. One hello per pair every so often.
const hiSeen = new Map()
let hiTick = 0

function tickHellos(now, roomEl, allowedNames = null) {
  if (!roomEl || now - hiTick < 160) {
    return
  }

  hiTick = now
  const walks = $walks.get()
  const roam = $roam.get()
  const allowed = allowedNames ? new Set(allowedNames) : null
  const names = Object.keys($seats.get()).filter(name => (!allowed || allowed.has(name)) && (walks[name] || roam[name]))
  if (names.length < 2) {
    return
  }

  const spots = names.map(name => ({ name, pos: currentPos(name, roomEl, now) })).filter(x => x.pos)
  const others = Object.keys($seats.get()).filter(name => (!allowed || allowed.has(name)) && !walks[name] && !roam[name]).map(name => ({ name, pos: $seats.get()[name] }))

  for (const a of spots) {
    for (const b of [...spots, ...others]) {
      if (a.name === b.name || !near(a.pos, b.pos, 46)) {
        continue
      }

      const key = [a.name, b.name].sort().join('|')
      if (now - (hiSeen.get(key) || 0) < 9000) {
        continue
      }

      hiSeen.set(key, now)
      patchFx(a.name, { hiUntil: now + 1100 })
      patchFx(b.name, { hiUntil: now + 1100 })
    }
  }
}

// After dark, bots left alone at their desks get sleepy: the odd yawn, and
// after a few quiet minutes they nod off. A task or a pet wakes them.
let nightTick = 0

function tickNight(now, night, roster, jobs, activeProfile, turnBusy) {
  if (now - nightTick < 1000) {
    return
  }

  nightTick = now
  const seats = $seats.get()
  const drag = $drag.get()

  for (const bot of roster || []) {
    const name = bot.name
    const row = $fx.get()[name] || {}
    const busy = deskMood({ isActive: name === activeProfile, turnBusy, tasked: Boolean(jobs?.[name]) }) === 'think'
    const away = Boolean(seats[name]) || drag?.name === name

    if (!night || busy || away) {
      if (row.idleSince) {
        patchFx(name, { idleSince: 0 })
      }
      continue
    }

    if (row.nap) {
      continue
    }

    if (!row.idleSince) {
      patchFx(name, { idleSince: now })
      continue
    }

    if (now - row.idleSince > 150000) {
      patchFx(name, { nap: true, yawnUntil: 0 })
      continue
    }

    if ((row.yawnUntil || 0) < now && Math.random() < 0.02) {
      patchFx(name, { yawnUntil: now + 1500 })
    }
  }
}

// On the hour, idle bots at their desks look up and stretch. Once per hour on
// its own, and again on request (clicking the clock within ten minutes of the
// hour) so nobody has to be watching at exactly the right second.
function ritualDue(state, date) {
  const hour = date.getHours()
  return date.getMinutes() === 0 && state.hour !== hour ? hour : -1
}

function ritualReplayable(state, now) {
  return new Date(now).getMinutes() < 10 || (state.at > 0 && now - state.at < RITUAL_WINDOW_MS)
}

function runRitual(roster, jobs, activeProfile, turnBusy, hour) {
  const now = Date.now()
  const seats = $seats.get()
  let i = 0

  for (const bot of roster || []) {
    const busy = deskMood({ isActive: bot.name === activeProfile, turnBusy, tasked: Boolean(jobs?.[bot.name]) }) === 'think'
    if (busy || seats[bot.name] || $drag.get()?.name === bot.name) {
      continue
    }

    const wait = 120 * i++
    patchFx(bot.name, { ritualUntil: now + wait + RITUAL_MS, stretchUntil: now + wait + 900 })
  }

  $ritual.set({ hour: typeof hour === 'number' ? hour : $ritual.get().hour, at: now })
  savePref('ritualHour', $ritual.get().hour)
}

function tickWalks(now) {
  const walks = $walks.get()
  let dirty = false
  const next = { ...walks }

  for (const [name, walk] of Object.entries(walks)) {
    const step = advanceWalk(walk, now)
    if (step.done) {
      delete next[name]
      finishWalk(name, walk)
      if (walk.to && walk.kind !== 'home') {
        puffAt(walk.to.x + FACE_HALF, walk.to.y + FACE_HALF * 2)
      }
      dirty = true
    } else if (step.walk && step.walk !== walk) {
      next[name] = step.walk
      if (walk.kind === 'hopscotch' && walk.to) {
        puffAt(walk.to.x + FACE_HALF, walk.to.y + FACE_HALF * 2)
      }
      dirty = true
    }
  }

  if (dirty) {
    $walks.set(next)
  }
}

function flushGoFlags(roomEl) {
  if (!roomEl) {
    return
  }

  const fx = $fx.get()

  for (const name of Object.keys(fx)) {
    const row = fx[name]
    if (row.goHome) {
      patchFx(name, { goHome: false, atBar: false, lingerUntil: 0 })
      startWalkHome(name, roomEl)
    } else if (row.goBar) {
      patchFx(name, { goBar: false })
      startWalkToBar(name, roomEl)
    }
  }
}

function gameBox(roomEl) {
  const box = roamBox(roomEl)
  const bar = roomEl?.querySelector('.office-bar')

  if (bar) {
    const room = roomEl.getBoundingClientRect()
    const edge = bar.getBoundingClientRect()
    box.x1 = Math.min(box.x1, edge.left - room.left - 18)
  }

  return box
}

function stopMusicalChairs() {
  $game.set(null)
}

function startMusicalChairs(roster, jobs, activeProfile, turnBusy, roomEl) {
  if ($game.get()) {
    stopMusicalChairs()
    return false
  }

  const players = idleBotNames(roster, jobs, activeProfile, turnBusy)
  if (players.length < 2 || !roomEl) {
    return false
  }

  const watchers = roster.map(bot => bot.name).filter(name => !players.includes(name) && !jobIsActive(jobs[name]))

  const seats = { ...$seats.get() }

  for (const name of players) {
    if (!seats[name] && !$walks.get()[name]) {
      const pos = deskPersonPos(name, roomEl)
      if (pos) {
        seats[name] = pos
      }
    }

  }

  saveSeats(seats)
  const box = gameBox(roomEl)
  const chairs = placeChairs(chairCountForGame(players.length), box)
  const ring = gameRing(box, chairs.length)

  for (const name of players) {
    const from = currentPos(name, roomEl) || seats[name]
    if (from) {
      const to = ringPoint(ring, from, 0)
      $roam.set({ ...$roam.get(), [name]: { from, to, t0: Date.now(), ms: Math.max(420, roamMs(from, to) * 0.6), rest: 60 } })
    }
  }

  $game.set({ phase: 'scramble', t0: Date.now(), players, chairs, ring, watchers })
  tap()
  return true
}

function startSit(game, roomEl) {
  const now = Date.now()
  const people = (game.players || []).map(name => ({
    name,
    x: (currentPos(name, roomEl, now) || {}).x || 0,
    y: (currentPos(name, roomEl, now) || {}).y || 0
  }))
  const chairs = game.chairs || placeChairs(chairCountForGame(people.length), gameBox(roomEl))
  const { assigned, leftover } = assignChairs(people, chairs)

  for (const [name, chair] of Object.entries(assigned)) {
    startWalk(name, { ...chair, x: chair.x + CHAIR_PX / 2 - FACE_HALF, y: chair.y + CHAIR_PX / 2 - FACE_HALF - 10 }, roomEl, 'chair')
  }

  if (leftover) {
    const mid = roamPoint(roomEl)
    startWalk(leftover, mid, roomEl, 'chair')
    patchFx(leftover, { stretchUntil: now + 2200 })
  }

  $game.set({
    phase: 'sit',
    t0: now,
    players: game.players,
    chairs,
    leftover,
    assigned
  })
}

function tickGame(now, roomEl, jobs) {
  const game = $game.get()
  if (!game || !roomEl) {
    return
  }

  if (game.phase === 'scramble') {
    tickRoam(now, roomEl, { scramble: true, only: game.players, jobs, ring: game.ring })

    if (now - game.t0 > 4200) {
      // Music stops. Everyone freezes where they are for a beat.
      const seats = { ...$seats.get() }
      const roam = { ...$roam.get() }
      for (const name of game.players || []) {
        const pos = currentPos(name, roomEl, now)
        if (pos) {
          seats[name] = pos
        }
        delete roam[name]
      }
      saveSeats(seats)
      $roam.set(roam)
      $game.set({ ...game, phase: 'freeze', t0: now })
    }

    return
  }

  if (game.phase === 'freeze') {
    if (now - game.t0 > 420) {
      startSit(game, roomEl)
    }

    return
  }

  if (game.phase === 'sit') {
    const walking = (game.players || []).some(name => $walks.get()[name])
    if (!walking || now - game.t0 > 3600) {
      const clapUntil = now + 1100
      for (const name of game.players || []) {
        if (name !== game.leftover) {
          patchFx(name, { clapUntil })
        }
      }

      for (const name of game.watchers || []) {
        if (!jobs?.[name]) {
          patchFx(name, { clapUntil: now + 1400 })
        }
      }

      $game.set({ ...game, phase: 'out', t0: now })
    }

    return
  }

  if (game.phase === 'out' && now - game.t0 > 2200) {
    $game.set(null)
  }
}

function WorkerFace({ color, image, mood, size = 36, name, sad = false }) {
  const shy = mood === 'shy' || mood === 'held'
  const sleep = mood === 'sleep'
  const peek = mood === 'peek'
  const bored = mood === 'bored'
  const eyeY = peek ? 11 : shy ? 15 : bored ? 19 : sad ? 18 : 17
  const eyeL = shy ? 13.5 : 15
  const eyeR = shy ? 26.5 : 25
  const rx = shy ? 3.1 : 2.4
  const ry = shy ? 3.4 : peek ? 3 : bored ? 1.2 : 2.4
  const hash = nameHash(name)

  if (image) {
    return jsx('img', {
      src: image,
      alt: '',
      'aria-hidden': true,
      draggable: false,
      className: cn('office-face', `office-face-${mood}`),
      style: {
        width: size,
        height: size,
        borderRadius: '28%',
        objectFit: 'cover',
        display: 'block',
        pointerEvents: 'none'
      }
    })
  }

  const ink = 'rgba(0,0,0,0.82)'
  // Sad brows: body colored lids that sit over the top of each eye at a
  // slant. Parked above the eye (and see-through) the rest of the time so
  // the mood can slide in instead of popping.
  const lidY = sad ? eyeY - ry * 1.3 : eyeY - ry * 2.6
  const eye = (side, cx) =>
    jsxs('g', {
      className: cn('office-eye', side === 'l' ? 'office-eye-l' : 'office-eye-r'),
      children: [
        jsx('ellipse', { className: 'office-pupil', cx, cy: eyeY, rx, ry, fill: ink }),
        jsx('ellipse', {
          className: 'office-lid',
          cx,
          cy: lidY,
          rx: rx + 0.9,
          ry: ry + 0.4,
          fill: color,
          opacity: sad ? 1 : 0,
          transform: `rotate(${side === 'l' ? -18 : 18} ${cx} ${eyeY})`
        })
      ]
    })

  return jsxs('svg', {
    viewBox: '0 0 40 44',
    width: size,
    height: size,
    'aria-hidden': true,
    className: cn('office-face', `office-face-${mood}`, sad && 'is-sad'),
    children: [
      jsx('rect', { x: 3, y: 3, width: 34, height: 34, rx: 11, fill: color }),
      sleep || mood === 'pet' || mood === 'clap'
        ? jsx('path', {
            d: 'M12 17 Q15 20 18 17 M22 17 Q25 20 28 17',
            fill: 'none',
            stroke: ink,
            strokeWidth: 2,
            strokeLinecap: 'round'
          })
        : jsxs('g', {
            className: 'office-eyes',
            children: [
              // office-gaze: slow wander plus a glance aside now and then, on
              // each bot's own clock. office-blink: the lid squash, also on
              // its own clock, and a quarter of the bots double blink.
              jsx('g', {
                className: 'office-gaze',
                style: {
                  animationDuration: `${(8 + (hash % 41) / 10).toFixed(1)}s`,
                  animationDelay: `-${hash % 7900}ms`
                },
                children: jsxs('g', {
                  className: cn('office-blink', hash % 4 === 0 && 'is-double'),
                  style: {
                    animationDuration: `${(3.2 + (hash % 27) / 10).toFixed(1)}s`,
                    animationDelay: `-${hash % 2900}ms`
                  },
                  children: [eye('l', eyeL), eye('r', eyeR)]
                })
              }),
              shy
                ? jsx('ellipse', { cx: 31, cy: 9, rx: 1.6, ry: 2.4, fill: 'rgba(120,190,255,0.95)' })
                : null
            ]
          }),
      sleep
        ? jsx('text', { x: 30, y: 10, fontSize: 7, fill: ink, opacity: 0.7, children: 'z' })
        : null,
      mood === 'think'
        ? jsxs('g', {
            children: [
              jsx('circle', { cx: 16, cy: 40, r: 1.2, fill: color, className: 'office-dot office-dot-0' }),
              jsx('circle', { cx: 20, cy: 40, r: 1.2, fill: color, className: 'office-dot office-dot-1' }),
              jsx('circle', { cx: 24, cy: 40, r: 1.2, fill: color, className: 'office-dot office-dot-2' })
            ]
          })
        : null
    ]
  }, name)
}

function statusText({ face, isActive, wander, cheers, gamePhase, leftover, pizza, noPizza, walkKind, five, yawn, ritual, taskState }) {
  if (taskState === 'failed') return '失败'
  if (taskState === 'unknown') return '状态？'
  if (face === 'sleep') {
    return '呼…'
  }

  if (face === 'held') {
    return '啊！'
  }

  if (face === 'pet') {
    return '嘿嘿'
  }

  if (pizza) {
    return '披萨！'
  }

  if (noPizza) {
    return '没披萨'
  }

  if (five) {
    return '击掌！'
  }

  if (yawn && face !== 'sleep') {
    return '哈欠'
  }

  if (ritual && face !== 'sleep' && face !== 'think') {
    return '休息'
  }

  if (cheers) {
    return '干杯'
  }

  if (face === 'clap') {
    return '耶！'
  }

  if (leftover) {
    return '哎呀'
  }

  if (gamePhase === 'scramble') {
    return '跑！'
  }

  if (gamePhase === 'freeze') {
    return '！'
  }

  if (gamePhase === 'sit') {
    return '坐下'
  }

  if (face === 'stretch') {
    return '嘿咻'
  }

  if (face === 'shy') {
    return '呀'
  }

  if (face === 'peek') {
    return '咘？'
  }

  if (face === 'think') {
    return '思考中'
  }

  if (face === 'bored') {
    return '无聊'
  }

  if (walkKind === 'hopscotch') {
    return '跳跳'
  }

  if (walkKind === 'bar') {
    return '去吧台'
  }

  if (walkKind === 'home') {
    return '回座位'
  }

  if (walkKind === 'chair') {
    return '我的！'
  }

  if (wander) {
    return '溜达'
  }

  return isActive ? '在岗' : '在工位'
}

function PizzaSlice({ className }) {
  return jsxs('svg', {
    viewBox: '0 0 20 20',
    width: 18,
    height: 18,
    className,
    'aria-hidden': true,
    children: [
      jsx('path', { d: 'M2 3 L18 3 L10 19 Z', fill: '#f2b53a' }),
      jsx('path', { d: 'M2 3 L18 3 L16.6 6 L3.4 6 Z', fill: '#c9702c' }),
      jsx('circle', { cx: 8, cy: 9, r: 1.6, fill: '#c9302c' }),
      jsx('circle', { cx: 12.5, cy: 10.5, r: 1.5, fill: '#c9302c' }),
      jsx('circle', { cx: 10, cy: 14, r: 1.3, fill: '#c9302c' })
    ]
  })
}

function Person({ bot, look, face, wander, closer, whisper, hi, ask, bang, five, yawn, cheers, gamePhase, leftover, pizza, noPizza, walkKind, drop, ritual, taskState, style, onPetStart }) {
  const life = useValue($officeLife)
  const needsInput = Boolean(useValue($officeInput)[bot.name])
  const quirk = officeQuirk(bot.name, life)
  const chatter = useValue($officeChatter)[bot.name]
  const status = needsInput ? '待输入' : statusText({ face, isActive: onPetStart.isActive, wander, cheers, gamePhase, leftover, pizza, noPizza, walkKind, five, yawn, ritual, taskState })
  return jsxs('div', {
    className: cn('office-person', `quirk-${quirk.id}`, `is-${face}`, needsInput && 'is-waiting', wander && 'is-wander', closer && 'is-closer', cheers && 'is-cheers', pizza && 'has-pizza', drop && 'is-drop', ritual && 'is-lookup'),
    style,
    role: 'button',
    tabIndex: 0,
    'aria-label': `抚摸 ${look.title}`,
    title: `${look.title}。悬停吓一跳，点击抚摸，长按哄睡，拖动移动。`,
    onPointerEnter: onPetStart.onEnter,
    onPointerLeave: onPetStart.onLeave,
    onPointerDown: onPetStart.onDown,
    onKeyDown: event => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }

      event.preventDefault()
      onPetStart.onActivate?.()
    },
    children: [
      face === 'pet' || face === 'clap' || cheers
        ? jsxs('div', { className: 'office-hearts', 'aria-hidden': true, children: [jsx('span', { children: '♥' }), jsx('span', { children: '♥' }), jsx('span', { children: '♥' })] })
        : null,
      whisper || hi || ask || bang
        ? jsx('div', { className: cn('office-whisper', (hi || ask || bang) && 'is-hi'), children: hi ? '嗨！' : ask ? '？' : bang ? '！' : '\u2026' })
        : null,
      chatter && chatter.until > Date.now() && face !== 'think' ? jsx('span', { className: 'office-banter', children: chatter.text }) : null,
      wander ? jsx('span', { className: 'office-ground', 'aria-hidden': true }) : null,
      pizza ? jsx(PizzaSlice, { className: 'office-slice' }) : null,
      jsx(WorkerFace, { color: look.color, image: look.image, mood: face, size: 42, name: bot.name, sad: Boolean(noPizza || leftover) && (face === 'idle' || face === 'stretch') }),
      jsx('span', {
        className: cn('office-status', (face === 'idle' || face === 'shy' || face === 'sleep') && 'is-idle', noPizza && 'is-sad', quietStatus(status) && 'is-quiet'),
        children: status
      })
    ]
  })
}

function usePersonHandlers(bot, roomRef, held) {
  const [shy, setShy] = useState(false)
  const [pet, setPet] = useState(false)
  const petTimer = useRef(null)
  const startRef = useRef(null)
  const sleepRef = useRef(null)
  const teardownRef = useRef(null)

  const burstPet = () => {
    const now = Date.now()
    setPet(true)
    clearTimeout(petTimer.current)
    petTimer.current = setTimeout(() => setPet(false), 900)
    patchFx(bot.name, { stretchUntil: now + 700, closerUntil: now + 2600, nap: false, idleSince: 0 })
    pickBot(bot.name)
    dismissHint()
    tap()
  }

  useEffect(() => () => {
    teardownRef.current?.()
    startRef.current = null
    if ($drag.get()?.name === bot.name) $drag.set(null)
    clearTimeout(petTimer.current)
    clearTimeout(sleepRef.current)
  }, [])

  return {
    shy,
    pet,
    handlers: {
      onEnter: () => {
        setShy(true)
        tap()
      },
      onLeave: () => {
        if (!held) {
          setShy(false)
        }
      },
      onActivate: () => burstPet(),
      onDown: event => {
        if (event.button !== 0) {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        teardownRef.current?.()
        try { event.currentTarget?.setPointerCapture?.(event.pointerId) } catch { /* older browser */ }
        startRef.current = { x: event.clientX, y: event.clientY }
        clearTimeout(sleepRef.current)
        sleepRef.current = setTimeout(() => {
          if (startRef.current) {
            patchFx(bot.name, { nap: true })
            const next = pointInRoom(roomRef.current, startRef.current.x, startRef.current.y)
            $drag.set({ name: bot.name, x: next.x, y: next.y, asleep: true })
          }
        }, SLEEP_HOLD_MS)

        const move = ev => {
          if (!startRef.current) {
            return
          }

          if (!movedEnough(startRef.current, { x: ev.clientX, y: ev.clientY }) && !$drag.get()) {
            return
          }

          clearTimeout(sleepRef.current)
          const next = pointInRoom(roomRef.current, ev.clientX, ev.clientY)
          const asleep = Boolean(($fx.get()[bot.name] || {}).nap)
          $drag.set({ name: bot.name, x: next.x, y: next.y, asleep })
        }

        const cleanup = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', cancel)
          window.removeEventListener('blur', cancel)
          teardownRef.current = null
        }
        const cancel = () => {
          cleanup()
          clearTimeout(sleepRef.current)
          startRef.current = null
          if ($drag.get()?.name === bot.name) $drag.set(null)
          patchFx(bot.name, { nap: false })
        }
        const up = ev => {
          cleanup()
          clearTimeout(sleepRef.current)
          const start = startRef.current
          startRef.current = null
          const dragged = Boolean($drag.get() && $drag.get().name === bot.name)
          const moved = movedEnough(start, { x: ev.clientX, y: ev.clientY })

          if (!moved) {
            if (dragged) {
              $drag.set(null)
              patchFx(bot.name, { nap: false })
            } else {
              burstPet()
            }
            return
          }

          const next = pointInRoom(roomRef.current, ev.clientX, ev.clientY)
          dropBot(bot.name, next, roomRef.current)
          setShy(false)
        }

        teardownRef.current = cleanup
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', cancel)
        window.addEventListener('blur', cancel)
      }
    }
  }
}

function Desk({ bot, isActive, turnBusy, tasked, taskState, picked, roomRef, night, peek, now, onPick, onOpen }) {
  const look = botLook(bot)
  const needsInput = Boolean(useValue($officeInput)[bot.name])
  const think = deskMood({ isActive, turnBusy, tasked }) === 'think'
  const handle = botHandle(bot.name)
  const seats = useValue($seats)
  const drag = useValue($drag)
  const walks = useValue($walks)
  const fx = readFx(bot.name, now)
  const seat = drag?.name === bot.name || walks[bot.name] ? true : seats[bot.name]
  const held = drag?.name === bot.name
  const { shy, pet, handlers } = usePersonHandlers(bot, roomRef, held)
  const lastTask = useValue($lastTask)
  const note = Boolean(useValue($news)[bot.name]) && !think
  const bored = !seat && !think && isBored(lastTask[bot.name], now)
  const face = faceMood({
    held,
    asleep: fx.nap || Boolean(drag?.asleep && held),
    pet: pet || fx.petted,
    clap: fx.clap,
    stretch: fx.stretch || fx.yawn,
    shy,
    peek: peek && !seat,
    think,
    bored
  })
  const output = outputText(bot)
  const game = useValue($game)
  const trophies = useValue($trophies)
  const deskRef = useRef(null)
  let watchDx = null

  if (game?.ring && !seat && !think && !(game.players || []).includes(bot.name) && deskRef.current && roomRef?.current) {
    const me = elPos(roomRef.current, deskRef.current)
    if (me) {
      const box = deskRef.current.getBoundingClientRect()
      watchDx = game.ring.center.x > me.x + box.width / 2 ? '2px' : '-2px'
    }
  }

  return jsxs('div', {
    ref: deskRef,
    className: cn(
      'office-desk',
      think && 'is-think',
      isActive && 'is-active',
      picked && 'is-picked',
      seat && 'has-wander',
      night && 'is-night'
    ),
    'data-desk': bot.name,
    children: [
      jsxs('div', {
        className: 'office-stage',
        children: [
          jsx('div', { className: 'office-desk-top' }),
          jsx(DeskKeepsakes, { name: bot.name }),
          note
            ? jsx('button', {
                type: 'button',
                className: 'office-memo',
                title: `${look.title} 有新消息。打开聊天。`,
                onClick: event => {
                  event.stopPropagation()
                  void onOpen()
                },
                children: jsx(PropArt, { id: 'parcel' })
              })
            : null,
          night
            ? jsxs('div', {
                className: 'office-lamp',
                'aria-hidden': true,
                children: [
                  jsx('div', { className: 'office-lamp-shade' }),
                  jsx('div', { className: 'office-lamp-stem' }),
                  jsx('div', { className: 'office-lamp-base' })
                ]
              })
            : null,
          jsx(Monitor, { on: think, text: output, since: fx.thinkSince, now, boot: fx.boot, doodle: bored }),
          fx.confetti
            ? jsx('div', {
                className: 'office-confetti',
                'aria-hidden': true,
                children: Array.from({ length: 7 }, (_, i) => jsx('i', { style: { '--i': i } }, i))
              })
            : null,
          jsxs('div', {
            className: 'office-seat',
            children: [
              jsx(DeskChair, { wobble: Boolean(seat) }),
              seat
                ? null
                : jsx(Person, {
                    bot,
                    look,
                    face,
                    wander: false,
                    closer: fx.closer,
                    whisper: fx.whisper,
                    hi: fx.hi,
                    ask: fx.ask,
                    bang: fx.bang,
                    yawn: fx.yawn,
                    ritual: fx.ritual,
                    style: watchDx ? { '--wdx': watchDx } : undefined,
                    taskState,
                    onPetStart: { ...handlers, isActive }
                  })
            ]
          })
        ]
      }),
      jsxs('button', {
        type: 'button',
        className: 'office-plate',
        onClick: onPick,
        onDoubleClick: event => {
          event.preventDefault()
          event.stopPropagation()
          void onOpen()
        },
        title: `给 ${look.title} 派个任务。双击打开其聊天。`,
        children: [
          jsx('div', { className: 'office-name', children: look.title }),
          jsxs('div', {
            className: 'office-handle',
            children: [
              `@${handle}`,
              trophies[bot.name] ? jsx('span', { className: 'office-stars', title: `${trophies[bot.name]} 个任务完成`, children: `\u2605 ${trophies[bot.name]}` }) : null
            ]
          })
        ]
      }),
      needsInput ? jsx('button', { type: 'button', className: 'office-input-request', onClick: onOpen, children: '举手 · 待答复问题' }) : null,
      output
        ? jsx('button', {
            type: 'button',
            className: 'office-say',
            onClick: onOpen,
            title: `打开 ${look.title} 的聊天`,
            children: output
          })
        : null,
      picked
        ? jsx('button', {
            type: 'button',
            className: 'office-home',
            onClick: onOpen,
            children: '打开聊天'
          })
        : null,
      seat
        ? jsx('button', {
            type: 'button',
            className: 'office-home',
            onClick: () => startWalkHome(bot.name, roomRef.current),
            children: '回工位'
          })
        : null
    ]
  })
}

function Doodle() {
  return jsxs('svg', { viewBox: '0 0 48 26', className: 'office-doodle', 'aria-hidden': true, children: [
    jsx('circle', { cx: 12, cy: 13, r: 7, fill: 'none', stroke: '#c9d4c4', strokeWidth: 1.2 }),
    jsx('circle', { cx: 9.5, cy: 11, r: 1, fill: '#c9d4c4' }),
    jsx('circle', { cx: 14.5, cy: 11, r: 1, fill: '#c9d4c4' }),
    jsx('path', { d: 'M9 15 Q12 18 15 15', fill: 'none', stroke: '#c9d4c4', strokeWidth: 1.2, strokeLinecap: 'round' }),
    jsx('path', { d: 'M24 18 C 27 6, 31 22, 34 10 S 41 20, 44 8', fill: 'none', stroke: '#c9d4c4', strokeWidth: 1.2, strokeLinecap: 'round', className: 'office-doodle-line' })
  ] })
}

function Monitor({ on, text, since, now, boot, doodle }) {
  const copy = on ? typedText(text || '> 工作中', since ? Math.max(0, (now || 0) - since) : 1e9) : text

  return jsxs('div', {
    className: 'office-monitor',
    'aria-hidden': true,
    children: [
      jsxs('div', {
        className: 'office-monitor-head',
        children: [
          jsx('div', {
            className: cn('office-screen', on && 'is-on', copy && 'has-copy', boot && 'is-boot'),
            children: !on && doodle ? jsx(Doodle, {}) : copy ? jsx('div', { className: 'office-screen-copy', children: copy }) : null
          }),
          jsx('div', { className: 'office-monitor-cam' })
        ]
      }),
      jsx('div', { className: 'office-monitor-neck' }),
      jsx('div', { className: 'office-monitor-base' })
    ]
  })
}

function WandererBot({ bot, isActive, turnBusy, tasked, taskState, roomRef, now, drag, seats, walk, roam, game }) {
  const look = botLook(bot)
  const think = deskMood({ isActive, turnBusy, tasked }) === 'think'
  const held = drag?.name === bot.name
  const fx = readFx(bot.name, now)
  const { shy, pet, handlers } = usePersonHandlers(bot, roomRef, held)
  let seat = held ? { x: drag.x, y: drag.y } : seats[bot.name]

  let squash = null
  let lift = 0
  let heading = 0

  if (walk) {
    const raw = Math.min(1, (now - walk.t0) / Math.max(1, walk.ms))
    const t = walkEase(raw, walk.kind)
    const hop = walkHop(raw, walk.kind)
    seat = {
      x: walk.from.x + (walk.to.x - walk.from.x) * t,
      y: walk.from.y + (walk.to.y - walk.from.y) * t - hop
    }
    lift = Math.min(1, hop / 12)
    heading = Math.sign(walk.to.x - walk.from.x)
    if (walk.kind === 'hopscotch') {
      const { sx, sy } = hopSquash(raw, walk.kind)
      squash = 'scale(' + sx.toFixed(3) + ', ' + sy.toFixed(3) + ')'
    }
  } else if (roam && !held) {
    const span = Math.max(1, roam.ms)
    const raw = Math.min(1, (now - roam.t0) / span)
    const t = easeInOut(raw)
    const hop = walkHop(raw, game?.phase === 'scramble' ? 'scramble' : 'roam')
    seat = {
      x: roam.from.x + (roam.to.x - roam.from.x) * t,
      y: roam.from.y + (roam.to.y - roam.from.y) * t - hop
    }
    lift = Math.min(1, hop / 12)
    heading = raw < 1 ? Math.sign(roam.to.x - roam.from.x) : 0
  }

  if (!seat) {
    return null
  }

  return jsx(Person, {
    bot,
    look,
    face: faceMood({
      held,
      asleep: fx.nap || Boolean(drag?.asleep && held),
      pet: pet || fx.petted,
      clap: fx.clap,
      stretch: fx.stretch,
      shy,
      peek: false,
      think
    }),
    wander: true,
    closer: fx.closer,
    whisper: fx.whisper,
    cheers: fx.cheers,
    pizza: fx.pizza,
    noPizza: fx.noPizza,
    walkKind: walk?.kind || null,
    drop: fx.drop,
    hi: fx.hi,
    ask: fx.ask,
    bang: fx.bang,
    five: fx.five,
    gamePhase: game?.players?.includes(bot.name) ? game.phase : null,
    leftover: game?.leftover === bot.name,
    taskState,
    style: {
      left: seat.x,
      top: seat.y,
      transform: squash || undefined,
      '--lift': lift.toFixed(2),
      '--wdx': heading ? `${heading * 2}px` : '0px'
    },
    onPetStart: { ...handlers, isActive }
  })
}

function Wanderers({ roster, isActiveName, turnBusy, jobs, roomRef }) {
  const seats = useValue($seats)
  const drag = useValue($drag)
  const walks = useValue($walks)
  const roam = useValue($roam)
  const game = useValue($game)
  const moving = Boolean(drag) || Object.keys(walks).length > 0 || Object.keys(roam).length > 0 || Boolean(game)
  const now = usePulse(moving ? 16 : 240)
  const names = new Set([...Object.keys(seats), drag?.name, ...Object.keys(walks)].filter(Boolean))

  useEffect(() => {
    flushGoFlags(roomRef.current)
    tickWalks(now)
    tickGame(now, roomRef.current, jobs)
    tickHellos(now, roomRef.current, roster.map(bot => bot.name))
  }, [now, jobs, roomRef, roster])

  return jsx('div', {
    className: 'office-wander-layer',
    children: roster
      .filter(bot => names.has(bot.name))
      .map(bot =>
        jsx(
          WandererBot,
          {
            bot,
            isActive: bot.name === isActiveName,
            turnBusy,
            tasked: jobIsActive(jobs[bot.name]),
            taskState: jobs[bot.name]?.state,
            roomRef,
            now,
            drag,
            seats,
            walk: walks[bot.name],
            roam: roam[bot.name],
            game
          },
          bot.name
        )
      )
  })
}

// A wooden slat chair for musical chairs.
function GameChair({ claimed, id, style }) {
  return jsxs('svg', {
    viewBox: '0 0 30 36',
    width: 30,
    height: 36,
    className: cn('office-game-chair', claimed && 'is-claimed'),
    'data-game-chair': id,
    style,
    'aria-hidden': true,
    children: [
      jsx('rect', { x: 6, y: 1, width: 18, height: 14, rx: 3, fill: '#a26b3f' }),
      jsx('rect', { x: 8, y: 5, width: 14, height: 2, rx: 1, fill: 'rgba(0,0,0,.18)' }),
      jsx('rect', { x: 8, y: 9, width: 14, height: 2, rx: 1, fill: 'rgba(0,0,0,.18)' }),
      jsx('rect', { x: 3, y: 15, width: 24, height: 7, rx: 2, fill: '#b87b4a' }),
      jsx('rect', { x: 3, y: 15, width: 24, height: 2, rx: 1, fill: 'rgba(255,255,255,.28)' }),
      jsx('rect', { x: 5, y: 22, width: 3, height: 13, rx: 1, fill: '#6b4425' }),
      jsx('rect', { x: 22, y: 22, width: 3, height: 13, rx: 1, fill: '#6b4425' }),
      jsx('rect', { x: 8, y: 27, width: 14, height: 2, rx: 1, fill: '#6b4425' })
    ]
  })
}

// The office chair at every desk. Bots sit on it; it wobbles when they leave.
function DeskChair({ wobble }) {
  return jsxs('svg', {
    viewBox: '0 0 42 46',
    width: 42,
    height: 46,
    className: cn('office-desk-chair', wobble && 'is-wobble'),
    'aria-hidden': true,
    children: [
      jsx('rect', { x: 8, y: 1, width: 26, height: 22, rx: 7, fill: '#3b3b43' }),
      jsx('rect', { x: 11, y: 4, width: 20, height: 16, rx: 5, fill: '#4c4c56' }),
      jsx('rect', { x: 4, y: 22, width: 34, height: 10, rx: 4, fill: '#454550' }),
      jsx('rect', { x: 4, y: 22, width: 34, height: 3, rx: 1.5, fill: 'rgba(255,255,255,.14)' }),
      jsx('rect', { x: 19.5, y: 32, width: 3, height: 7, rx: 1, fill: '#8a8a94' }),
      jsx('path', { d: 'M21 39 L7 44 M21 39 L35 44 M21 39 L21 45', stroke: '#8a8a94', strokeWidth: 2.4, strokeLinecap: 'round' }),
      jsx('circle', { cx: 7, cy: 44.5, r: 1.6, fill: '#26262c' }),
      jsx('circle', { cx: 35, cy: 44.5, r: 1.6, fill: '#26262c' }),
      jsx('circle', { cx: 21, cy: 45, r: 1.6, fill: '#26262c' })
    ]
  })
}

function Puffs() {
  const puffs = useValue($puffs)
  if (!puffs.length) {
    return null
  }

  return jsx('div', {
    className: 'office-puff-layer',
    'aria-hidden': true,
    children: puffs.map(p => jsx('span', { className: 'office-puff', style: { left: p.x, top: p.y } }, p.id))
  })
}

// Eyes follow the pointer when it is close. Done straight on the DOM so a
// moving mouse does not re-render the whole floor.
function useEyeTracking(roomRef) {
  useEffect(() => {
    const room = roomRef.current
    if (!room || reducedMotion()) {
      return undefined
    }

    let frame = 0
    let last = null

    const apply = () => {
      frame = 0
      const faces = room.querySelectorAll('svg.office-face')
      for (const face of faces) {
        if (!last) {
          face.style.removeProperty('--edx')
          face.style.removeProperty('--edy')
          continue
        }

        const box = face.getBoundingClientRect()
        const vx = last.x - (box.left + box.width / 2)
        const vy = last.y - (box.top + box.height / 2)
        const d = Math.hypot(vx, vy)
        if (d > 200 || d < 1) {
          face.style.removeProperty('--edx')
          face.style.removeProperty('--edy')
          continue
        }

        const k = Math.min(1, d / 60) * 2.2
        face.style.setProperty('--edx', `${((vx / d) * k).toFixed(2)}px`)
        face.style.setProperty('--edy', `${((vy / d) * k * 0.7).toFixed(2)}px`)
      }
    }

    const onMove = event => {
      last = { x: event.clientX, y: event.clientY }
      if (!frame) {
        frame = requestAnimationFrame(apply)
      }
    }

    const onLeave = () => {
      last = null
      if (!frame) {
        frame = requestAnimationFrame(apply)
      }
    }

    room.addEventListener('pointermove', onMove)
    room.addEventListener('pointerleave', onLeave)
    return () => {
      room.removeEventListener('pointermove', onMove)
      room.removeEventListener('pointerleave', onLeave)
      if (frame) {
        cancelAnimationFrame(frame)
      }
    }
  }, [roomRef])
}

function GameChairs() {
  const game = useValue($game)
  if (!game?.chairs?.length) {
    return null
  }

  const center = game.ring?.center
  const notes = game.phase === 'scramble' && center && !reducedMotion()
    ? [0, 1, 2, 3].map(i =>
        jsx('span', {
          className: 'office-note',
          style: { left: center.x + [-30, 18, -6, 34][i], top: center.y + [-46, -60, -78, -40][i], '--d': `${i * 0.45}s` },
          children: i % 2 ? '\u266a' : '\u266b'
        }, i)
      )
    : []

  return jsxs('div', {
    className: 'office-game-layer',
    'aria-hidden': true,
    children: [
      ...game.chairs.map(chair =>
        jsx(GameChair, { id: chair.id, claimed: game.phase === 'out', style: { left: chair.x, top: chair.y } }, chair.id)
      ),
      ...notes
    ]
  })
}

// Chalk hopscotch on the floor: 1, 2, 3|4, 5, 6|7, 8.

function litHopSquares(walks, now) {
  const lit = new Set()
  for (const walk of Object.values(walks || {})) {
    if (walk?.kind !== 'hopscotch') {
      continue
    }

    const raw = (now - walk.t0) / Math.max(1, walk.ms)
    const spot = raw < 0.45 ? walk.from : raw > 0.8 ? walk.to : null
    for (const id of String(spot?.id || '').split('-')) {
      if (id) {
        lit.add(id)
      }
    }
  }

  return lit
}

function Hopscotch({ onHop, now }) {
  const walks = useValue($walks)
  const lit = litHopSquares(walks, now)

  return jsxs('div', {
    className: 'office-aisle',
    children: [
      jsx('div', { className: 'office-hop-label', children: '跳' }),
      ...HOP_ROWS.map(row =>
        jsx(
          'div',
          {
            className: 'office-hop-row',
            children: row.map(n =>
              jsx(
                'button',
                {
                  type: 'button',
                  className: cn('office-hop', lit.has(String(n)) && 'is-lit'),
                  'data-hop': String(n),
                  'aria-label': `跳房子第 ${n} 格`,
                  title: '点击让空闲机器人跳房子',
                  onPointerDown: event => {
                    event.stopPropagation()
                    onHop?.()
                  },
                  children: n
                },
                n
              )
            )
          },
          row.join('-')
        )
      )
    ]
  })
}

// The pie on the pizza counter. Loses a slice once someone has claimed it.
function PizzaPie({ eaten }) {
  return jsxs('svg', {
    viewBox: '0 0 40 40',
    width: 34,
    height: 34,
    className: cn('office-pie', eaten && 'is-eaten'),
    'aria-hidden': true,
    children: [
      jsx('circle', { cx: 20, cy: 20, r: 19.5, fill: '#4a4a4e' }),
      jsx('circle', { cx: 20, cy: 20, r: 18, fill: '#c9702c' }),
      jsx('circle', { cx: 20, cy: 20, r: 15, fill: '#f2b53a' }),
      jsxs('g', {
        fill: '#c9302c',
        children: [
          jsx('circle', { cx: 13, cy: 14, r: 2.4 }),
          jsx('circle', { cx: 25, cy: 12, r: 2.4 }),
          jsx('circle', { cx: 28, cy: 23, r: 2.4 }),
          jsx('circle', { cx: 18, cy: 26, r: 2.4 }),
          jsx('circle', { cx: 10, cy: 24, r: 2.2 }),
          jsx('circle', { cx: 21, cy: 19, r: 2 })
        ]
      }),
      jsxs('g', {
        fill: '#4f8f38',
        children: [
          jsx('ellipse', { cx: 16, cy: 20, rx: 2, ry: 1.2, transform: 'rotate(-30 16 20)' }),
          jsx('ellipse', { cx: 25, cy: 28, rx: 2, ry: 1.2, transform: 'rotate(20 25 28)' })
        ]
      }),
      jsx('path', { d: 'M20 20 L20 3 A17 17 0 0 1 35.6 11 Z', stroke: 'rgba(0,0,0,.18)', strokeWidth: 1, fill: 'none' }),
      eaten
        ? jsx('path', { d: 'M20 20 L20 1.5 A18.5 18.5 0 0 1 36.7 11.2 Z', fill: '#4a4a4e' })
        : null
    ]
  })
}

// Back bar: a row of bottles on the shelf.
function OfficeBar({ count, now }) {
  const n = Math.min(6, Math.max(3, count || 3))
  const pizza = useValue($pizza)
  const ding = pizza?.at && !pizza.winner && (now || 0) - pizza.at < 1400

  return jsxs('aside', {
    className: 'office-bar',
    children: [
      jsx('div', { className: 'office-bar-sign', children: '披萨时间' }),
      ding ? jsx('div', { className: 'office-ding office-chip', children: '叮！' }) : null,
      jsx('div', { className: 'office-bar-shelf', 'aria-hidden': true, children: null }),
      jsx('div', {
        className: 'office-bar-counter',
        'aria-hidden': true,
        children: jsx(PizzaPie, { eaten: Boolean(pizza?.winner) })
      }),
      jsx('div', {
        className: 'office-bar-stools',
        children: Array.from({ length: n }, (_, i) =>
          jsx('div', { className: 'office-bar-stool', 'data-stool': String(i), 'aria-hidden': true }, i)
        )
      })
    ]
  })
}

function FloorTools({ roster, jobs, activeProfile, turnBusy, roomRef, idleCount }) {
  const game = useValue($game)

  return jsxs('div', {
    className: 'office-tools',
    children: [
      jsx('button', {
        type: 'button',
        className: cn('office-tool', game && 'is-on'),
        title: game ? '停止抢椅子' : '玩抢椅子',
        disabled: !game && idleCount < 2,
        onClick: () => {
          startMusicalChairs(roster, jobs, activeProfile, turnBusy, roomRef.current)
        },
        children: game ? '停' : '椅子'
      })
    ]
  })
}

// One small living thing per room, so each skin feels like a place. Plus the
// tally board on the wall once anyone has finished a task.
function SunMoon({ sky }) {
  const left = `calc(8% + ${(sky.t * 84).toFixed(1)}%)`
  const top = 46 - Math.sin(sky.t * Math.PI) * 32
  return sky.night
    ? jsxs('svg', { className: 'office-moon', viewBox: '0 0 20 20', width: 18, height: 18, style: { left, top }, children: [
        jsx('circle', { cx: 10, cy: 10, r: 8, fill: '#f4f0d8' }),
        jsx('circle', { cx: 13.5, cy: 8, r: 7, fill: '#0f1a3a' })
      ] })
    : jsx('svg', { className: 'office-sun', viewBox: '0 0 20 20', width: 22, height: 22, style: { left, top }, children: jsx('circle', { cx: 10, cy: 10, r: 8, fill: sky.tone === 'day' ? '#ffd44d' : '#ffb347' }) })
}

function WallWindow({ sky }) {
  const glass = { day: '#a9d8f2', dawn: '#f6c9a0', dusk: '#f0a05a', night: '#182a58' }[sky.tone]
  const cx = 6 + sky.t * 28
  const cy = 24 - Math.sin(sky.t * Math.PI) * 12
  return jsxs('svg', { className: 'office-window', viewBox: '0 0 44 40', width: 44, height: 40, children: [
    jsx('rect', { x: 2, y: 2, width: 40, height: 34, rx: 3, fill: glass }),
    sky.night
      ? jsxs('g', { fill: '#f4f0d8', children: [jsx('circle', { cx: 12, cy: 10, r: .9 }), jsx('circle', { cx: 30, cy: 14, r: .8 }), jsx('circle', { cx: 22, cy: 24, r: .7 }), jsx('circle', { cx: cx, cy: cy, r: 3.2 })] })
      : jsx('circle', { cx, cy, r: 3.6, fill: sky.tone === 'day' ? '#ffd44d' : '#ffb347' }),
    jsx('rect', { x: 20.5, y: 2, width: 3, height: 34, fill: '#f4efe6' }),
    jsx('rect', { x: 2, y: 17.5, width: 40, height: 3, fill: '#f4efe6' }),
    jsx('rect', { x: 2, y: 2, width: 40, height: 34, rx: 3, fill: 'none', stroke: '#f4efe6', strokeWidth: 3 }),
    jsx('rect', { x: 0, y: 35, width: 44, height: 4, rx: 1, fill: '#e2d9c8' })
  ] })
}

// A framed portrait on the wall for the bot with the most tasks this month.
function EmployeeOfMonth({ roster }) {
  const stats = useValue($month)
  const holder = stats && stats.start === monthStart(new Date()) ? stats.holder : null
  const bot = holder ? roster.find(row => row.name === holder) : null
  if (!bot) {
    return null
  }

  const look = botLook(bot)
  const n = stats.tasks?.[holder] || 0
  const month = new Date().toLocaleString(undefined, { month: 'long' })

  return jsxs('div', {
    className: 'office-eom',
    title: `本月最佳员工：${look.title}，${month} ${n} 个任务`,
    children: [
      jsx('div', { className: 'office-eom-frame', children: jsx(WorkerFace, { color: look.color, image: look.image, mood: 'idle', size: 30, name: bot.name }) }),
      jsx('div', { className: 'office-eom-plate', children: '本月最佳员工' }),
      jsx('div', { className: 'office-eom-name', children: look.title })
    ]
  }, holder)
}

// "3 tasks done overall" plus who did what, for the tally board tooltip.
function tallyTitle(tally, trophies, roster) {
  const head = `${tally} 个任务总计完成`
  const rows = (roster || [])
    .map(bot => [botLook(bot).title, (trophies || {})[bot.name] || 0])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([title, n]) => `${title}: ${n}`)
  return rows.length ? `${head}\n${rows.join('\n')}` : head
}

function Ambience({ backdrop, tally, sky, roster, trophies }) {
  const bits = [jsx(EmployeeOfMonth, { roster: roster || [] }, 'eom')]
  if (sky) bits.push(jsx(WallWindow, { sky }, 'window'))
  if (tally > 0) bits.push(jsx('div', { className: 'office-tally office-chip', title: tallyTitle(tally, trophies, roster), children: `${tally} 完成` }, 'tally'))
  if (backdrop === 'carpet') {
    bits.push(jsxs('svg', { className: 'office-cooler', viewBox: '0 0 22 52', width: 22, height: 52, children: [
      jsx('rect', { x: 4, y: 20, width: 14, height: 30, rx: 2, fill: '#e9ecf0' }),
      jsx('rect', { x: 4, y: 20, width: 14, height: 4, fill: '#c9d0da' }),
      jsx('rect', { x: 8, y: 30, width: 6, height: 4, rx: 1, fill: '#4f7cff' }),
      jsx('rect', { x: 5, y: 2, width: 12, height: 19, rx: 4, fill: '#a9d8f2', opacity: 0.9 }),
      jsx('circle', { className: 'office-bubble', cx: 9, cy: 16, r: 1.3, fill: '#fff' }),
      jsx('circle', { className: 'office-bubble is-2', cx: 13, cy: 18, r: 1, fill: '#fff' })
    ] }, 'cooler'))
  }


  return jsx(Fragment, { children: bits })
}

function HintBubble({ roster, stage, onClose, selectedName }) {
  const target = roster.find(row => row.name === selectedName) || roster[0]
  const first = target ? botLook(target).title : '一个机器人'
  const copy = stage === 'task'
    ? [jsx('b', { children: `给 ${first} 派个小任务。` }, 'b'), ' 在下方输入框输入并点击发送。观察它的工位。']
    : [jsx('b', { children: `${first} 回来了。试着摸摸它。` }, 'b'), ' 悬停吓一跳，点击抚摸，长按哄睡，拖动移动。然后点跳房子格或按椅子。']

  return jsxs('div', {
    className: cn('office-hint', stage === 'task' && 'is-task'),
    role: 'note',
    children: [
      jsx('div', { className: 'office-hint-copy', children: copy }),
      jsx('button', { type: 'button', className: 'office-hint-close', 'aria-label': '关闭', onClick: onClose, children: '\u00d7' })
    ]
  })
}

// Stages: 'task' (show the first bubble), 'wait' (task sent, hold), 'play'
// (show the second bubble), 'done'. 'off' means storage has not answered yet.
function setHint(stage) {
  $hint.set(stage)
  savePref('hintStage', stage)
}

function advanceHint(next) {
  const cur = $hint.get()
  if (cur === 'off' || cur === 'done') {
    return
  }
  if (next === 'wait' && cur === 'task') {
    setHint('wait')
  } else if (next === 'play' && (cur === 'wait' || cur === 'task')) {
    setHint('play')
  }
}

// Doing any of the things the bubble teaches puts it away.
function dismissHint() {
  const cur = $hint.get()
  if (cur === 'off' || cur === 'done') {
    return
  }
  setHint('done')
}

// "Scout thinking", "Scout, Arke thinking", "Scout, Arke +2 thinking".
function headerNames(names, one, many) {
  return headerLine(names, one, many)
}

function scrollToDesk(roomEl, name) {
  const desk = roomEl?.querySelector?.(`[data-desk=${JSON.stringify(name)}]`)
  if (desk?.scrollIntoView) {
    desk.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center', inline: 'nearest' })
  }
  pickBot(name)
}

function OfficeProps({ now, roomRef, onReplay }) {
  const clockKind = useValue($clockKind)
  const clockPos = useValue($clockPos)
  const dragged = useRef(false)
  const teardownRef = useRef(null)
  const stamp = new Date(now)
  const label = clockLabel(stamp)
  const hands = clockHands(stamp)

  useEffect(() => () => teardownRef.current?.(), [])

  const onClockDown = event => {
    if (event.button !== 0) {
      return
    }

    event.stopPropagation()
    teardownRef.current?.()
    try { event.currentTarget?.setPointerCapture?.(event.pointerId) } catch { /* older browser */ }
    const start = { x: event.clientX, y: event.clientY }
    dragged.current = false

    const move = ev => {
      if (!movedEnough(start, { x: ev.clientX, y: ev.clientY }) && !dragged.current) {
        return
      }

      dragged.current = true
      $clockPos.set(pointOnWall(roomRef.current, ev.clientX, ev.clientY))
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      teardownRef.current = null
    }
    const cancel = () => {
      cleanup()
      dragged.current = false
    }
    const up = ev => {
      cleanup()

      if (!dragged.current) {
        return
      }

      const next = pointOnWall(roomRef.current, ev.clientX, ev.clientY)
      $clockPos.set(next)
      savePref('clockPos', next)
    }

    teardownRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
  }

  const onClock = event => {
    event.preventDefault()
    event.stopPropagation()

    if (dragged.current) {
      return
    }

    const next = nextClockKind($clockKind.get())
    $clockKind.set(next)
    savePref('clock', next)
    onReplay?.()
  }

  return jsxs(Fragment, {
    children: [
      jsxs('button', {
        type: 'button',
        className: cn('office-clock', clockKind === 'digital' && 'is-digital', clockPos && 'is-free'),
        style: clockPos ? { left: clockPos.x, top: clockPos.y } : undefined,
        title: clockKind === 'digital' ? '拖动移动。点击切换指针钟。' : '拖动移动。点击切换数字钟。',
        onPointerDown: onClockDown,
        onClick: onClock,
        children: [
          clockKind === 'analog'
            ? jsxs('div', {
                className: 'office-clock-face',
                children: [
                  jsx('div', { className: 'office-clock-hour', style: { transform: `rotate(${hands.hour}deg)` } }),
                  jsx('div', { className: 'office-clock-min', style: { transform: `rotate(${hands.minute}deg)` } }),
                  jsx('div', { className: 'office-clock-pin' })
                ]
              })
            : jsx('div', { className: 'office-clock-lcd', children: label }),
          clockKind === 'analog' ? jsx('span', { className: 'office-clock-digits', children: label }) : null
        ]
      })
    ]
  })
}

function BotPicker({ roster, bot, look }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const close = event => {
      if (!boxRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }

    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  return jsxs('div', {
    className: 'office-task-who',
    ref: boxRef,
    children: [
      jsx('span', { children: '派给' }),
      jsxs('div', {
        className: 'office-pick',
        children: [
          jsx('button', {
            type: 'button',
            className: 'office-pick-btn',
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            'aria-label': '选择机器人',
            onClick: () => setOpen(on => !on),
            children: look.title
          }),
          open
            ? jsx('div', {
                className: 'office-pick-menu',
                role: 'listbox',
                children: roster.map(row =>
                  jsx(
                    'button',
                    {
                      type: 'button',
                      role: 'option',
                      className: cn('office-pick-item', row.name === bot.name && 'is-on'),
                      'aria-selected': row.name === bot.name,
                      onClick: () => {
                        pickBot(row.name)
                        setOpen(false)
                      },
                      children: botLook(row).title
                    },
                    row.name
                  )
                )
              })
            : null
        ]
      })
    ]
  })
}

// Measure the send button and the target desk's monitor, both relative to the
// office root, and let a plane fly between them.
function launchPlane(buttonEl, name) {
  const root = buttonEl?.closest?.('.office-root')
  const monitor = root?.querySelector?.(`[data-desk=${JSON.stringify(name)}] .office-monitor-head`)
  if (!root || !monitor || reducedMotion()) {
    return
  }

  const base = root.getBoundingClientRect()
  const a = buttonEl.getBoundingClientRect()
  const b = monitor.getBoundingClientRect()
  flyPlane(
    { x: a.left - base.left + a.width / 2, y: a.top - base.top + a.height / 2 },
    { x: b.left - base.left + b.width / 2, y: b.top - base.top + b.height / 2 }
  )
}

function Planes() {
  const planes = useValue($planes)
  if (!planes.length) {
    return null
  }

  return jsx('div', {
    className: 'office-plane-layer',
    'aria-hidden': true,
    children: planes.map(p => {
      const dx = p.to.x - p.from.x
      const dy = p.to.y - p.from.y
      const rot = (Math.atan2(dy, dx) * 180) / Math.PI
      return jsx('svg', {
        viewBox: '0 0 24 16',
        width: 24,
        height: 16,
        className: 'office-plane',
        style: { left: p.from.x, top: p.from.y, '--dx': `${dx}px`, '--dy': `${dy}px`, '--rot': `${rot}deg` },
        children: jsx('path', { d: 'M1 2 H23 V14 H1 Z M1 2 L12 9 L23 2 M1 14 L8 8 M23 14 L16 8', fill: '#fff0d3', stroke: '#8c7454', strokeWidth: 1, strokeLinejoin: 'round' })
      }, p.id)
    })
  })
}

function TaskBar({ roster, activeProfile }) {
  const grillState = useValue($grill)
  const grillActive = !!(grillState && grillState.ctxKey === 'task')
  const selected = useValue($selected)
  const focusToken = useValue($focusTask)
  const jobs = useValue($jobs)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)
  const sendRef = useRef(null)
  const picked = resolvePicked(roster, selected, activeProfile)
  const bot = roster.find(row => row.name === picked) || null
  const look = bot ? botLook(bot) : null
  const job = bot ? jobs[bot.name] : null
  const sending = Boolean(job && (job.state === JOB_STATES.SUBMITTING || job.state === JOB_STATES.RUNNING))
  const unknown = Boolean(job?.state === JOB_STATES.UNKNOWN)

  useEffect(() => {
    if (!focusToken || !inputRef.current) {
      return
    }

    inputRef.current.focus()
    inputRef.current.select?.()
  }, [focusToken])

  useEffect(() => {
    if (job?.state === JOB_STATES.FAILED && !text.trim() && job.prompt) {
      setText(job.prompt)
    }
  }, [job?.id, job?.state])

  if (!bot || !look) {
    return null
  }

  const send = async () => {
    const task = text.trim()

    if (!task || busy || sending) {
      return
    }

    setBusy(true)
    pickBot(bot.name)
    launchPlane(sendRef.current, bot.name)

    try {
      await sendTask(bot, task)
      setText('')
    } catch (err) {
      setText(task)
      try { host.notifyError(err, `无法发送给 ${look.title}`) } catch { /* older shell */ }
    } finally {
      setBusy(false)
    }
  }

  return jsxs('form', {
    className: 'office-taskbar',
    onSubmit: event => {
      event.preventDefault()
      void send()
    },
    children: [
      grillActive && grillState ? jsx(OsGrillPanel, { grill: grillState }) : null,
      jsx(BotPicker, { roster, bot, look }),
      jsx('button', {
        type: 'button',
        className: 'office-task-attach',
        title: '上传附件（图片 / 文件，随消息一并发送）',
        onClick: () => { void osPickAttachment(bot, setText) },
        children: '📎'
      }),
      grillActive && grillState ? jsx(OsGrillPanel, { grill: grillState }) : null,
      jsx('input', {
        ref: inputRef,
        className: cn('office-task-input', job?.state === JOB_STATES.FAILED && 'is-failed'),
        value: text,
        placeholder: grillActive ? '拷问进行中…（Enter 提交答案 / 生成简报 · Esc 恢复原稿）' : sending ? `${look.title} 正在处理…` : job?.state === JOB_STATES.FAILED ? '检查失败的任务并重试…' : `告诉 ${look.title}…（/ 命令 · 📎 附件 · Tab 拷问）`,
        disabled: busy || sending || unknown || grillActive,
        'aria-describedby': job?.error ? 'office-task-status' : undefined,
        onChange: event => {
          setText(event.target.value)
          const rosterMembers = roster.map(r => ({ key: r.name, name: r.name, seat: r.name, label: (botLook(r) || {}).title || r.name, machine: 'pc2' }))
          osAssistOnChange(event.target.value, event.target, v => setText(v), rosterMembers, item => {
            pickBot(item.name)
            const elx = inputRef.current
            const caret2 = elx && elx.selectionStart != null ? elx.selectionStart : event.target.value.length
            const at2 = event.target.value.lastIndexOf('@', caret2)
            if (at2 >= 0) setText(event.target.value.slice(0, at2) + event.target.value.slice(caret2))
          })
        },
        onKeyDown: event => {
          const a = $assist.get()
          if (a && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Tab' || event.key === 'Escape' || (event.key === 'Enter' && a.items && a.items.length))) { osAssistOnKey(event); return }
          if (grillActive && grillState) {
            if (event.key === 'Escape') { event.preventDefault(); osGrillClose(true); return }
            if (event.key === 'Enter') { event.preventDefault(); (grillState.question && !grillState.done) ? osGrillSubmit(null) : osGrillBrief(); return }
            if (event.key === 'Tab') { event.preventDefault(); if (grillState.question) osGrillSubmit(grillState.recommended || grillState.inputAnswer); return }
            return
          }
          if (event.key === 'Tab' && text.trim()) { event.preventDefault(); osGrillStart('task', text, v => setText(v)); return }
        }
      }),
      unknown
        ? jsxs(Fragment, { children: [
            jsx('button', { type: 'button', className: 'office-task-recover', onClick: () => void openBot(bot), children: '打开聊天' }),
            jsx('button', {
              type: 'button',
              className: 'office-task-recover',
              onClick: async () => {
                const copied = await pluginCtx?.os?.writeClipboard?.(job.prompt)
                if (!copied) host.notify?.({ kind: 'error', message: '无法复制任务。' })
              },
              children: '复制任务'
            }),
            jsx('button', { type: 'button', className: 'office-task-recover', onClick: () => clearJob(bot.name, job.id), children: '忽略' })
          ] })
        : jsx('button', {
            ref: sendRef,
            type: 'submit',
            className: 'office-task-send',
            disabled: busy || sending || !text.trim(),
            children: sending ? '处理中' : job?.state === JOB_STATES.FAILED ? '重试' : '发送'
          }),
      job?.error ? jsx('span', { id: 'office-task-status', className: 'office-task-status', role: 'status', children: job.error }) : null,
      jsx(OsAssistLayer, {})
    ]
  })
}

// Office life is local stagecraft. It never dispatches work or invents job events.
const OFFICE_QUIRKS = [
  { id: 'mugs', name: '马克杯收藏家', line: '这是我备用杯子的备用杯子。', prop: 'coffee' },
  { id: 'tidy', name: '强迫症整理狂', line: '谁把它挪了三像素？', prop: 'bin' },
  { id: 'champion', name: '胜利爱好者', line: '我要感谢键盘。', prop: 'chair' },
  { id: 'quiet', name: '低调实干家', line: '我把它放你桌上了。', prop: 'cat' },
  { id: 'curious', name: '按钮调查员', line: '它大概会做点合理的事。', prop: 'fan' }
]
const OFFICE_FURNITURE = [
  { id: 'coffee', name: '咖啡机', unlock: 0, x: 17, y: 79 },
  { id: 'fan', name: '桌面风扇', unlock: 0, x: 35, y: 81 },
  { id: 'chair', name: '滚轮椅', unlock: 0, x: 53, y: 78 },
  { id: 'bin', name: '废纸篓', unlock: 0, x: 69, y: 83 },
  { id: 'cat', name: '办公室猫', unlock: 0, x: 83, y: 78 },
  { id: 'certificate', name: '首次交付证书', unlock: 1, x: 12, y: 63 },
  { id: 'aquarium', name: '鱼缸', unlock: 5, x: 31, y: 65 },
  { id: 'button', name: '可疑按钮', unlock: 10, x: 66, y: 67 },
  { id: 'pizza-box', name: '披萨名人堂', unlock: 20, x: 83, y: 63 }
]
const OFFICE_INCIDENTS = {
  boss: { title: '老板来巡视了', prop: 'chair', lines: ['有人推开了经理的门。', '快速扫一眼第一个工位。非常严肃的剪贴板工作。', '来到下一个工位。咖啡杯正被检查。', '一切看起来大致井井有条。', '检查完毕。剪贴板回到楼上。'] },
  printer: { title: '打印机有话说', prop: 'bin', lines: ['打印机要求更多纸张。全部。', '风扇接住了一张纸。椅子加入了追逐。', '纸张收回了。打印机被要求反省。'] },
  delivery: { title: '一盆低调的植物送达', prop: 'coffee', lines: ['一个标着「小型植物」的包裹到了。', '它现在比送货机器人还高。', '这盆植物被任命为遮阴主管。'] },
  ufo: { title: '一位不速之客', prop: 'cat', lines: ['一艘迷你 UFO 正在检查墙上的画像。', '机组提出用一块披萨作为交换。', '画像归还。外交关系尝起来是奶酪味的。'] },
  mouse: { title: '老鼠出逃', prop: 'cat', lines: ['一只发条老鼠开溜了。', '猫追了上去。滚轮椅提供了载具。', '老鼠抓回来了。猫在邀功。'] },
  ice: { title: '地板极度过滑', prop: 'chair', lines: ['地毯暂时变成了冰。', '没人有这把椅子的驾照。', '摩擦力恢复了。尊严还要再等等。'] },
  ball: { title: '室内排球委员会', prop: 'fan', lines: ['一个沙滩球闯进了会议。', '风扇的发球出奇地好。', '再打一场的动议全票通过。'] },
  lunch: { title: '一顿紧急午餐', prop: 'coffee', lines: ['午餐铃响了。', '委员会在披萨柜台旁集合。', '午餐散会。会议纪要里留下了面包屑。'] },
  gravity: { title: '重力休假了', prop: 'chair', lines: ['重力出门了。', '请牢牢握住你的杯子。', '大家又脚踏实地了。基本如此。'] }
}
const $officeLife = atom({ quirks: {}, props: {}, stories: [], chaos: 'gentle' })
const $officeIncident = atom(null)
const $officeChatter = atom({})
const $officeArrange = atom(false)
let officeNextIncident = 0
let officeNextQuirk = 0

function clearOfficeInput(name) {
  if (!$officeInput.get()[name]) return
  const next = { ...$officeInput.get() }
  delete next[name]
  $officeInput.set(next)
}

function endOfficeIncident(now = Date.now()) {
  const incident = $officeIncident.get()
  if (!incident) return
  for (const name of incident.cast) {
    patchFx(name, { lingerUntil: 0 })
    const walk = $walks.get()[name]
    if (walk?.kind === 'visit') {
      const t = easeInOut(Math.max(0, Math.min(1, (now - walk.t0) / Math.max(1, walk.ms))))
      saveSeats({ ...$seats.get(), [name]: { x: walk.from.x + (walk.to.x - walk.from.x) * t, y: walk.from.y + (walk.to.y - walk.from.y) * t } })
      const walks = { ...$walks.get() }
      delete walks[name]
      $walks.set(walks)
    }
  }
  $officeChatter.set({})
  $officeIncident.set(null)
  officeNextIncident = now + ($officeLife.get().chaos === 'chaos' ? 45000 : 180000)
}

function incidentLine(incident) {
  const def = OFFICE_INCIDENTS[incident.kind]
  if (incident.kind === 'boss') return def.lines[incident.phase]
  const visible = id => officePropPosition(id).visible !== false
  if (incident.phase === 2 && incident.kind === 'mouse' && !visible('cat')) return '老鼠抓回来了。办公室又挺过了一次实验。'
  if (incident.phase !== 1) return def.lines[incident.phase]
  if (!incident.cast.length) return '大家都在工作。这件事交给办公室的物件处理了。'
  if (incident.kind === 'mouse' && (!visible('cat') || !visible('chair'))) return '老鼠躲过了办公室搜索队。'
  if (incident.kind === 'printer' && (!visible('fan') || !visible('chair'))) return '纸张越堆越高。搜索队钻进了纸堆。'
  if (incident.kind === 'ball' && !visible('fan')) return '办公室在练习一种非常随意的发球。'
  return def.lines[1]
}

function handleOfficeInput(name, row, event) {
  if (!jobIsActive(row)) return
  const id = event.payload?.request_id
  if (['approval.request', 'clarify.request', 'mcp.setup.request', 'sudo.request', 'secret.request'].includes(event.type) && typeof id === 'string' && id) {
    $officeInput.set({ ...$officeInput.get(), [name]: { id, job: row.id } })
  } else if (event.type === 'message.complete' || event.type === 'message.start') {
    clearOfficeInput(name)
  } else if (['clarify.expire', 'tool.complete'].includes(event.type) && $officeInput.get()[name]?.id === (id || event.payload?.tool_id)) {
    clearOfficeInput(name)
  }
}

function normalizeOfficeLife(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const quirks = Object.fromEntries(Object.entries(value.quirks || {}).filter(([name, id]) => name.length < 200 && OFFICE_QUIRKS.some(q => q.id === id)))
  const props = {}
  for (const p of OFFICE_FURNITURE) {
    const saved = value.props?.[p.id]
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      props[p.id] = { x: Math.max(6, Math.min(94, saved.x)), y: Math.max(48, Math.min(88, saved.y)), visible: saved.visible !== false }
    }
  }
  const stories = Array.isArray(value.stories) ? value.stories.filter(s => s && Number.isFinite(s.at) && s.at >= 0 && s.at <= 8640000000000000 && typeof s.text === 'string').slice(-60).map(s => ({
    at: s.at, type: typeof s.type === 'string' ? s.type : 'work', text: s.text.slice(0, 500),
    cast: Array.isArray(s.cast) ? s.cast.filter(n => typeof n === 'string').slice(0, 3) : [],
    scene: Object.hasOwn(OFFICE_INCIDENTS, s.scene) ? s.scene : null,
    snapshot: Array.isArray(s.snapshot) ? s.snapshot.filter(p => OFFICE_FURNITURE.some(f => f.id === p?.id) && Number.isFinite(p.x) && Number.isFinite(p.y)).slice(0, 9).map(p => ({ id: p.id, x: Math.max(6, Math.min(94, p.x)), y: Math.max(48, Math.min(88, p.y)) })) : []
  })) : []
  return { quirks, props, stories, chaos: ['quiet', 'gentle', 'chaos'].includes(value.chaos) ? value.chaos : 'gentle' }
}

function saveOfficeLife(next) {
  $officeLife.set(next)
  savePref('officeLife', next)
}

function officeQuirk(name, life = $officeLife.get()) {
  return OFFICE_QUIRKS.find(q => q.id === life.quirks[name]) || OFFICE_QUIRKS[nameHash(name) % OFFICE_QUIRKS.length]
}

function rememberOffice(type, text, cast = [], scene = null) {
  const life = $officeLife.get()
  const snapshot = OFFICE_FURNITURE.filter(p => life.props[p.id]?.visible ?? p.unlock === 0).map(p => ({ id: p.id, x: life.props[p.id]?.x ?? p.x, y: life.props[p.id]?.y ?? p.y }))
  saveOfficeLife({ ...life, stories: [...life.stories, { at: Date.now(), type, text, cast: cast.slice(0, 3), scene, snapshot }].slice(-60) })
}

function officeSay(name, text, ms = 4500) {
  $officeChatter.set({ ...$officeChatter.get(), [name]: { text, until: Date.now() + ms } })
}

function officePropPosition(id) {
  const p = OFFICE_FURNITURE.find(p => p.id === id)
  return { ...p, ...$officeLife.get().props[id] }
}

function officeCast(roster, jobs, activeProfile, turnBusy) {
  const players = new Set($game.get()?.players || [])
  return idleBotNames(roster, jobs, activeProfile, turnBusy).filter(name => !players.has(name) && $drag.get()?.name !== name && !$walks.get()[name])
}

function gatherOffice(cast, id, roomEl) {
  if (!roomEl) return
  const element = roomEl.querySelector(`[data-office-prop="${id}"]`)
  const anchor = element ? faceOn(roomEl, element, 25) : null
  if (!anchor) return
  cast.forEach((name, i) => {
    const x = Math.min(roomEl.scrollWidth - 45, Math.max(20, anchor.x + (i - 1) * 40))
    const y = Math.max(WALL_H + 40, anchor.y)
    startWalk(name, { x, y }, roomEl, 'visit')
    patchFx(name, { nap: false, lingerUntil: Date.now() + 15000 })
  })
}

function beginOfficeIncident(kind, roster, jobs, activeProfile, turnBusy, roomEl) {
  if ($officeIncident.get() || !Object.hasOwn(OFFICE_INCIDENTS, kind)) return false
  const cast = officeCast(roster, jobs, activeProfile, turnBusy).slice(0, 3)
  const def = OFFICE_INCIDENTS[kind]
  if (kind === 'boss') {
    const door = roomEl?.querySelector('.office-door')
    const entry = door ? faceOn(roomEl, door, -32) : { x: 300, y: 80 }
    const desks = roster.slice(0, 2).map(bot => {
      const element = roomEl?.querySelector(`[data-desk=${JSON.stringify(bot.name)}] .office-stage`)
      const point = element ? faceOn(roomEl, element, -48) : entry
      return { name: bot.name, ...point }
    })
    $officeIncident.set({ kind, cast, at: Date.now(), phase: 0, tour: [entry, desks[0] || entry, desks[1] || desks[0] || entry, entry] })
    for (const name of cast) {
      startWalkHome(name, roomEl)
      officeSay(name, officeQuirk(name).id === 'mugs' ? '快。把多余的杯子藏起来。' : '我正要去做那件事。')
    }
    return true
  }
  $officeIncident.set({ kind, cast, at: Date.now(), phase: 0 })
  gatherOffice(cast, def.prop, roomEl)
  if (cast[0]) officeSay(cast[0], '我去调查。', 4000)
  if (kind === 'lunch') $pizza.set(freshPizza(Date.now()))
  return true
}

function tickOfficeLife(now, roster, jobs, activeProfile, turnBusy, roomEl) {
  if (!roomEl || (typeof document !== 'undefined' && document.hidden)) return
  const incident = $officeIncident.get()
  const available = idleBotNames(roster, jobs, activeProfile, turnBusy)
  for (const [name, walk] of Object.entries($walks.get())) {
    if (walk.kind === 'visit' && !available.includes(name)) startWalkHome(name, roomEl)
  }
  if (incident) {
    const lastPhase = OFFICE_INCIDENTS[incident.kind].lines.length - 1
    const phase = Math.min(lastPhase, Math.floor((now - incident.at) / 4000))
    if (now - incident.at >= (lastPhase + 1) * 4000) {
      rememberOffice('incident', incidentLine({ ...incident, phase: lastPhase }), incident.cast, incident.kind)
      endOfficeIncident(now)
    } else if (phase !== incident.phase) {
      const cast = incident.cast.filter(n => available.includes(n) && $drag.get()?.name !== n && !($game.get()?.players || []).includes(n))
      $officeIncident.set({ ...incident, phase })
      if (incident.kind === 'boss') {
        const visited = incident.tour?.[phase < 2 ? 1 : 2]?.name
        if (visited && cast.includes(visited)) officeSay(visited, officeQuirk(visited).id === 'quiet' ? '结果在你桌上。' : '这是我的职业面孔。')
        return
      }
      if (cast[phase % Math.max(1, cast.length)]) officeSay(cast[phase % cast.length], phase === 1 ? officeQuirk(cast[phase % cast.length]).line : '无可奉告。绝对没有。')
      if (phase === 1) gatherOffice(cast, incident.kind === 'lunch' ? 'cat' : 'chair', roomEl)
      if (phase === 2 && incident.kind === 'lunch') cast.forEach(name => startWalkToBar(name, roomEl))
    }
    return
  }
  const chaos = $officeLife.get().chaos
  if (!officeNextIncident) officeNextIncident = now + 90000
  if (chaos !== 'quiet' && !$officeArrange.get() && !$game.get() && roster.length && now >= officeNextIncident) {
    const kinds = available.length ? ['boss', 'printer', 'boss', 'delivery', 'ufo'] : ['boss']
    beginOfficeIncident(kinds[Math.floor(Math.random() * kinds.length)], roster, jobs, activeProfile, turnBusy, roomEl)
  }
  if (!officeNextQuirk) officeNextQuirk = now + 24000
  if (chaos !== 'quiet' && !$officeArrange.get() && now >= officeNextQuirk) {
    officeNextQuirk = now + 24000
    const cast = officeCast(roster, jobs, activeProfile, turnBusy)
    if (!cast.length) return
    const name = cast[Math.floor(Math.random() * cast.length)]
    const q = officeQuirk(name)
    if (officePropPosition(q.prop).visible !== false) gatherOffice([name], q.prop, roomEl)
    const previous = $officeLife.get().stories.filter(s => s.scene && s.cast.includes(name)).at(-1)
    officeSay(name, previous ? `声明一下，${OFFICE_INCIDENTS[previous.scene].title.toLowerCase()} 不是我的主意。` : q.line)
    if (cast[1] && cast[1] !== name) officeSay(cast[1], q.id === 'mugs' ? '我们的橱柜装不下了。' : '记进会议纪要。')
  }
}

function bossPosition(tour, elapsed) {
  const t = Math.max(0, Math.min(20000, elapsed))
  const segment = t < 8000 ? 0 : t < 16000 ? 1 : 2
  const offset = segment === 0 ? 0 : segment === 1 ? 8000 : 16000
  const progress = easeInOut(Math.min(1, (t - offset) / 3400))
  const from = tour[segment], to = tour[segment + 1]
  return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress, walking: progress < 1, facing: to.x < from.x ? -1 : 1 }
}

function OfficeBoss() {
  const incident = useValue($officeIncident)
  const now = usePulse(incident?.kind === 'boss' ? 50 : 1000)
  if (incident?.kind !== 'boss' || !incident.tour) return null
  const pose = reducedMotion()
    ? { ...incident.tour[incident.phase < 2 ? 1 : incident.phase < 4 ? 2 : 3], walking: false }
    : bossPosition(incident.tour, now - incident.at)
  return jsxs('div', { className: 'office-boss', style: { left: pose.x, top: pose.y }, role: 'img', 'aria-label': '老板正在检查工位', children: [
    jsx('span', { className: 'office-boss-hair' }),
    jsx(WorkerFace, { color: '#d5ae8c', mood: 'idle', size: 42, name: 'office-manager' }),
    jsx('span', { className: 'office-boss-glasses' }),
    jsx('span', { className: 'office-clipboard' }),
    jsx('span', { className: 'office-boss-label', children: pose.walking ? '巡视中' : '记几笔…' })
  ] })
}

function PropArt({ id }) {
  // Small physical props share the room's existing paper-doll construction.
  return jsxs('span', { className: `office-object art-${id}`, 'aria-hidden': true, children: [jsx('i', {}), jsx('b', {}), jsx('em', {}), jsx('small', {})] })
}

function DeskKeepsakes({ name }) {
  const life = useValue($officeLife)
  const q = officeQuirk(name, life)
  return jsx('div', { className: `office-keepsakes keepsake-${q.id}`, title: q.name, 'aria-label': q.name,
    children: Array.from({ length: q.id === 'mugs' ? 3 : 1 }, (_, i) => jsx(PropArt, { id: q.id === 'mugs' ? 'mug' : q.id === 'tidy' ? 'certificate' : q.id === 'champion' ? 'button' : q.id === 'quiet' ? 'cat' : 'fan' }, i)) })
}

function OfficeFurniture({ item, roomRef, onUse }) {
  const arrange = useValue($officeArrange)
  const gesture = useRef(null)
  const move = event => {
    if (!gesture.current || !roomRef.current) return
    const box = event.currentTarget.parentElement.getBoundingClientRect()
    const next = { x: Math.max(6, Math.min(94, (event.clientX - box.left) / box.width * 100)), y: Math.max(48, Math.min(88, 48 + ((event.clientY - box.top) / box.height * 100 - 15) / 65 * 40)), visible: true }
    const life = $officeLife.get()
    $officeLife.set({ ...life, props: { ...life.props, [item.id]: next } })
  }
  return jsxs('button', {
    type: 'button', className: 'office-furniture', 'data-office-prop': item.id, style: { left: `${item.x}%`, top: `${15 + (item.y - 48) / 40 * 65}%` },
    title: arrange ? `${item.name}：拖动或用方向键移动` : `使用${item.name}`,
    'aria-label': arrange ? `移动${item.name}` : `使用${item.name}`,
    onPointerDown: event => {
      event.stopPropagation()
      if (arrange) { gesture.current = true; event.currentTarget.setPointerCapture(event.pointerId) }
    },
    onPointerMove: move,
    onPointerUp: () => { if (gesture.current) saveOfficeLife($officeLife.get()); gesture.current = null },
    onPointerCancel: () => { gesture.current = null; saveOfficeLife($officeLife.get()) },
    onClick: event => { event.stopPropagation(); if (!arrange) onUse(item.id) },
    onKeyDown: event => {
      if (!arrange || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const life = $officeLife.get()
      const dx = event.key === 'ArrowLeft' ? -2 : event.key === 'ArrowRight' ? 2 : 0
      const dy = event.key === 'ArrowUp' ? -2 : event.key === 'ArrowDown' ? 2 : 0
      saveOfficeLife({ ...life, props: { ...life.props, [item.id]: { x: Math.max(6, Math.min(94, item.x + dx)), y: Math.max(48, Math.min(88, item.y + dy)), visible: true } } })
    },
    children: [jsx(PropArt, { id: item.id }), jsx('span', { className: 'office-furniture-label', children: item.name })]
  })
}

function OfficeLifeScene({ roster, jobs, activeProfile, turnBusy, roomRef }) {
  const life = useValue($officeLife)
  const incident = useValue($officeIncident)
  const arrange = useValue($officeArrange)
  const useProp = id => {
    const kinds = { fan: 'ball', chair: 'ice', bin: 'printer', cat: 'mouse', coffee: 'lunch', button: 'gravity', aquarium: 'ufo', certificate: 'delivery', 'pizza-box': 'lunch' }
    beginOfficeIncident(kinds[id], roster, jobs, activeProfile, turnBusy, roomRef.current)
  }
  return jsxs('div', { className: cn('office-life-scene', arrange && 'is-arranging', incident && `incident-${incident.kind}`, incident && `phase-${incident.phase}`), children: [
    jsx('div', { className: 'office-coffee-rug', 'aria-hidden': true }),
    jsxs('div', { className: 'office-lounge-sofa', 'aria-hidden': true, children: [jsx('i', {}), jsx('b', {})] }),
    ...OFFICE_FURNITURE.filter(p => life.props[p.id]?.visible ?? p.unlock === 0).map(p => jsx(OfficeFurniture, { item: { ...p, ...life.props[p.id] }, roomRef, onUse: useProp }, p.id)),
    incident ? jsxs('div', { className: 'office-incident-art', 'aria-hidden': true, children: [jsx('span', { className: 'office-visiting-object' }), ...Array.from({ length: 6 }, (_, i) => jsx('i', { style: { '--n': i } }, i))] }) : null,
    jsx('span', { className: 'office-floor-plaque', children: '请喂养创意。还有猫。' })
  ] })
}

function OfficeLife({ roster, jobs, activeProfile, turnBusy, roomRef }) {
  const life = useValue($officeLife)
  const incident = useValue($officeIncident)
  const trophies = useValue($trophies)
  const arrange = useValue($officeArrange)
  const [panel, setPanel] = useState(null)
  const [story, setStory] = useState(null)
  const now = usePulse(500)
  const total = Object.values(trophies).reduce((a, b) => a + b, 0)
  const week = useValue($week)
  useEffect(() => {
    tickOfficeLife(now, roster, jobs, activeProfile, turnBusy, roomRef.current)
  }, [now, roster, jobs, activeProfile, turnBusy])
  useEffect(() => {
    const room = roomRef.current
    if (room) room.dataset.incident = incident?.kind || ''
    return () => { if (room) delete room.dataset.incident }
  }, [incident?.kind])
  useEffect(() => {
    const root = roomRef.current?.closest('.office-root')
    const visibility = () => {
      if (root) root.dataset.officeHidden = String(document.hidden)
      if (document.hidden) endOfficeIncident()
    }
    document.addEventListener('visibilitychange', visibility)
    visibility()
    return () => { document.removeEventListener('visibilitychange', visibility); if (root) delete root.dataset.officeHidden }
  }, [])
  useEffect(() => () => { endOfficeIncident(); $officeArrange.set(false); $officeChatter.set({}); officeNextIncident = 0; officeNextQuirk = 0 }, [])
  const action = (label, click, extra = {}) => jsx('button', { type: 'button', className: 'office-life-button', onClick: click, ...extra, children: label }, label)
  const toggle = name => { setPanel(panel === name ? null : name); $officeArrange.set(false) }
  return jsxs('section', { className: 'office-life', 'aria-label': '办公室生活', children: [
    jsxs('div', { className: 'office-life-toolbar', children: [
      jsx('span', { className: 'office-life-caption', children: '下班时间，也在营业。' }),
      action('玩具抽屉', () => toggle('toys'), { 'aria-expanded': panel === 'toys' }),
      action('布置家具', () => toggle('furnish'), { 'aria-expanded': panel === 'furnish' }),
      arrange ? action('完成布置', () => $officeArrange.set(false)) : null,
      action('性格', () => toggle('people'), { 'aria-expanded': panel === 'people' }),
      action('办公室报纸', () => toggle('paper'), { 'aria-expanded': panel === 'paper' }),
      jsxs('label', { className: 'office-chaos', children: ['办公室氛围 ', jsxs('select', { value: life.chaos, onChange: e => { saveOfficeLife({ ...life, chaos: e.target.value }); officeNextIncident = 0 }, children: [jsx('option', { value: 'quiet', children: '安静' }), jsx('option', { value: 'gentle', children: '轻微怪诞' }), jsx('option', { value: 'chaos', children: '混乱' })] })] })
    ] }),
    incident ? jsxs('div', { className: 'office-incident-caption', role: 'status', children: [jsx('strong', { children: OFFICE_INCIDENTS[incident.kind].title }), jsx('span', { children: incidentLine(incident) }), action('结束场景', () => endOfficeIncident(now))] }) : null,
    panel ? jsxs('div', { className: 'office-life-panel', onKeyDown: e => { if (e.key === 'Escape') { setPanel(null); $officeArrange.set(false) } }, children: [
      action('关闭', () => { setPanel(null); $officeArrange.set(false) }, { className: 'office-panel-close' }),
      panel === 'toys' ? jsxs(Fragment, { children: [jsx('h2', { children: '用于研究目的。' }), jsx('p', { children: '短小的办公室场景。忙碌的机器人会继续工作。' }), jsx('div', { className: 'office-toy-list', children: Object.entries({ mouse: '放出发条老鼠', ice: '给地毯结冰', ball: '丢沙滩球', lunch: '敲午餐铃', gravity: '关闭重力', printer: '挑衅打印机', delivery: '订购巨型植物', ufo: '邀请迷你 UFO', boss: '叫老板来' }).map(([id, label]) => action(label, () => { if (beginOfficeIncident(id, roster, jobs, activeProfile, turnBusy, roomRef.current)) setPanel(null) }, { disabled: Boolean(incident) })) })] }) : null,
      panel === 'furnish' ? jsxs(Fragment, { children: [jsx('h2', { children: '别客气，当自己家。' }), jsx('p', { children: `${total} 个已完成任务。纪念品会随着真实交付解锁。` }), action(arrange ? '完成布置' : '摆放家具', () => { $officeArrange.set(!arrange); if (!arrange) setPanel(null) }, { 'aria-pressed': arrange }), arrange ? jsx('p', { children: '在地毯上拖动物件，或聚焦后使用方向键。' }) : null, jsx('div', { className: 'office-furniture-list', children: OFFICE_FURNITURE.map(p => { const visible = life.props[p.id]?.visible ?? p.unlock === 0; return action(`${visible ? '收起' : '放置'} ${p.name}${total < p.unlock && !visible ? ` · ${p.unlock} 个任务` : ''}`, () => saveOfficeLife({ ...life, props: { ...life.props, [p.id]: { ...officePropPosition(p.id), visible: !visible } } }), { disabled: !visible && total < p.unlock }) }) })] }) : null,
      panel === 'people' ? jsxs(Fragment, { children: [jsx('h2', { children: '每个工位都有个性。' }), jsx('p', { children: '性格会影响工位物件、空闲习惯、反应与庆祝方式。' }), ...roster.map(bot => jsxs('label', { className: 'office-personality-row', children: [jsx('span', { children: botLook(bot).title }), jsxs('select', { value: officeQuirk(bot.name, life).id, onChange: e => saveOfficeLife({ ...life, quirks: { ...life.quirks, [bot.name]: e.target.value } }), children: OFFICE_QUIRKS.map(q => jsx('option', { value: q.id, children: q.name }, q.id)) })] }, bot.name))] }) : null,
      panel === 'paper' ? jsxs('article', { className: 'office-newspaper', children: [jsx('h2', { children: '地毯纪事报' }), jsx('p', { className: 'office-paper-date', children: new Date(now).toLocaleDateString(undefined, { dateStyle: 'full' }) }), jsx('p', { children: week && week.start === weekStart(new Date(now)) ? weekLine(week) || '地毯上安静的一周。' : '地毯上崭新的一周。' }), story ? jsxs('div', { className: 'office-memory', children: [jsx('strong', { children: story.scene ? OFFICE_INCIDENTS[story.scene].title : '摘自办公室档案' }), jsx('p', { children: story.text }), jsx('div', { className: 'office-memory-scene', 'aria-label': '已保存的家具布置', children: (story.snapshot || []).map(p => jsx('span', { style: { position: 'absolute', left: `${p.x}%`, top: `${(p.y - 45) * 1.5}%` }, children: jsx(PropArt, { id: p.id }) }, p.id)) }), jsx('p', { children: story.cast.length ? `在场：${story.cast.join(', ')}` : '一场席卷办公室的事件。' }), action('关闭回忆', () => setStory(null))] }) : null, life.stories.length ? jsx('ol', { children: [...life.stories].reverse().map((s, i) => jsx('li', { children: jsxs('button', { type: 'button', onClick: () => setStory(s), children: [jsx('time', { dateTime: new Date(s.at).toISOString(), children: new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }), ' ', s.text] }) }, `${s.at}-${i}`)) }) : jsx('p', { children: '还没有头条。完成一个任务或打开玩具抽屉，给编辑点可写的东西。' })] }) : null
    ] }) : null
  ] })
}


// ══ AMM OPC OS 公司级群聊（合议引擎）══
// 自研 per-member 轮转引擎（D1）：复刻 hermes-bots 原生模式，原语全是公开 RPC。
// 数据存本插件 storage（命名空间 OS_ROOMS_KEY），与 hermes-bots 零冲突。
// 公司级参数：成员上限 19（PC2 8 + PC1 11）、轮次可配 1~12 默认 6、手动续场、
// @mention 定向、(pass) 沉默、水位增量投递、中断可恢复、日志滚动 retention。
// 跨机成员（pc1/*）经快照服务 /api/action/a2a-send 同步代理（110s 窗回单句）。

const OS_ROOMS_KEY = 'osRooms'
const OS_MAX_MEMBERS = 19
const OS_DEFAULT_ROUNDS = 6
const OS_MAX_ROUNDS_LIMIT = 12
const OS_LOG_LIMIT = 200          // 每房滚动 retention
const OS_HISTORY_LINES = 24       // 注入协议时携带的新消息上限
const OS_TURN_TIMEOUT_MS = 600000 // 成员发言超时（09-20 controller 全员轮 300s 被掐实证后统一提到 600s；仍不够由 osMemberSpeak 的一次自动重试吸收）
const OS_DIRECTED_TIMEOUT_MS = 600000 // @点名定向轮超时（指名任务=终裁/执行清单，大上下文长输出；CEO 终裁 297s 被掐实证）
const OS_RESUME_POLL_MS = 5000
const OS_PARALLEL_CHUNK = 3       // 全员并行限流（防 8 席冷启动风暴）；组内乱序完成、按成员序入账

// ── 房间 atom 与持久化 ──
const $osRooms = atom([])
let osRoomsCtx = null
function loadOsRooms(ctx) {
  osRoomsCtx = ctx
  try {
    const saved = ctx.storage?.get?.(OS_ROOMS_KEY, null)
    if (Array.isArray(saved)) {
      $osRooms.set(saved)
      // 自举无人值守：标记 autoResume 且未落定/未在跑的房间，插件加载后自动续跑（外部编排回灌的房间靠它接原生轮转）
      for (const r of saved) {
        if (r.autoResume && r.engine && !r.engine.settled && !r.engine.running) {
          patchRoom(r.roomId, x => { x.autoResume = false; return x })
          setTimeout(() => { try { runOsRounds(r.roomId) } catch {} }, 3000)
        }
      }
      // 台账为唯一真值源（CEO 终裁原则）：加载时从服务端 hydrate 房间标记——
      // 外部经办（Zcode 收口）登记的提案/归档/工单，插件重载后 UI 即刻对齐，零点击同步
      setTimeout(() => { osHydrateRoomMarks().catch(() => {}) }, 1500)
    }
  } catch { /* no storage */ }
}
async function osHydrateRoomMarks() {
  const [props, dels, wos] = await Promise.all([
    fetch(API + '/api/ledger/proposals').then(r => r.json()).catch(() => null),
    fetch(API + '/api/ledger/deliberations').then(r => r.json()).catch(() => null),
    fetch(API + '/api/ledger/workorders').then(r => r.json()).catch(() => null),
  ])
  const propRows = Array.isArray(props) ? props : []
  const delRows = Array.isArray(dels) ? dels : []
  const woRows = Array.isArray(wos) ? wos : []
  for (const r of $osRooms.get() || []) {
    const patch = {}
    if (!r.proposalId) {
      const p = propRows.find(x => x && x.targetAnchor === '合议群 ' + r.roomId && x.currentStage !== '已废止')
      if (p) patch.proposalId = p.proposalId
    }
    if (!r.archivedId) {
      const d = delRows.find(x => x && x.roomId === r.roomId)
      if (d) patch.archivedId = d.deliberationId
    }
    if (!r.workOrderId) {
      const w = woRows.find(x => x && String(x.source || '').includes(r.roomId) && String(x.assignedSeat || '') === 'ceo')
      if (w) patch.workOrderId = w.workOrderId
    }
    if (Object.keys(patch).length) patchRoom(r.roomId, x => Object.assign(x, patch))
  }
}
function saveOsRooms() {
  try { osRoomsCtx?.storage?.set?.(OS_ROOMS_KEY, $osRooms.get()) } catch { /* no storage */ }
}
function getRoom(roomId) {
  return ($osRooms.get() || []).find(r => r.roomId === roomId) || null
}
function patchRoom(roomId, patcher) {
  const rooms = $osRooms.get().map(r => {
    if (r.roomId !== roomId) return r
    const next = typeof patcher === 'function' ? patcher({ ...r, engine: { ...(r.engine || {}) }, watermarks: { ...(r.watermarks || {}) }, sessions: { ...(r.sessions || {}) }, log: [...(r.log || [])], members: [...(r.members || [])] }) : { ...r, ...patcher }
    next.lastActiveAt = Date.now()
    return next
  })
  $osRooms.set(rooms)
  saveOsRooms()
}

// ── 工具 ──
function mintOsRoomId() {
  return 'osr' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
}
function isOsPass(text) {
  if (!text) return true
  return /^\(?\s*pass\s*\)?\.?$/i.test(String(text).trim())
}
// 发言顺序约束：独立评审判据前置 → 其余席位 → CEO 压轴裁定（rank 内保持原序，稳定排序）
function osSortMembers(members) {
  const rank = m => /independent-reviewer/i.test(String((m && m.seat) || '')) ? 0 : (String((m && m.seat) || '') === 'ceo' ? 2 : 1)
  return (members || []).map((m, i) => ({ m, i })).sort((a, b) => (rank(a.m) - rank(b.m)) || (a.i - b.i)).map(x => x.m)
}
// 防嵌套命名：递归剥掉「合议：」「合议结论：」前缀（结论提案再发起合议不会出现「合议：合议结论：…」）
function stripOsTitlePrefix(t) {
  let s = String(t || '')
  while (/^合议(结论)?：/.test(s)) s = s.replace(/^合议(结论)?：/, '')
  return s
}
// @提及解析：匹配成员的 seat / label（含 pc1 前缀）；@everyone/@all/全体 → 全员
function parseOsMentions(text, members) {
  if (!text) return members.slice()
  if (/@(everyone|all)\b|全体|大家/.test(text)) return members.slice()
  const hits = []
  for (const m of members) {
    const keys = [m.seat, m.label, m.seat && m.seat.replace(/^pc1[/-]/, '')].filter(Boolean)
    for (const k of keys) {
      if (new RegExp('@' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text)) { hits.push(m); break }
      if (new RegExp('@' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$|[^\\w-])', 'i').test(text)) { hits.push(m); break }
    }
  }
  const seen = new Set(); const out = []
  const order = []
  const lower = String(text).toLowerCase()
  for (const m of members) {
    const k = '@' + m.seat.toLowerCase()
    const idx = lower.indexOf(k)
    if (idx >= 0) order.push({ m, idx })
  }
  order.sort((a, b) => a.idx - b.idx)  // 按 @ 在文本中的出现顺序（路由顺序）
  for (const { m } of order) { if (!seen.has(m.key)) { seen.add(m.key); out.push(m) } }
  if (out.length) return out
  return members.slice()
}
// 水位增量：取该成员自上次发言后的新消息
function osNewMessages(room, memberKey) {
  const wm = (room.watermarks || {})[memberKey] || 0
  return (room.log || []).slice(wm).slice(-OS_HISTORY_LINES)
}
// 群聊协议 prompt
function buildOsTurnPrompt(room, member, newMsgs) {
  const lines = newMsgs.map(m => {
    const who = m.from.kind === 'user' ? '峰哥' : (m.from.label || m.from.seat)
    return `  ${who}: ${m.text}`
  }).join('\n')
  const modeNote = (room.mode || 'ASK') === 'EXEC'
    ? '【房间模式：执行】本轮可以执行与议题直接相关的操作。'
    : '【房间模式：合议讨论】三段纪律：①禁变更——不写文件、不建工单、不调 cron、不对外发送、不改配置（合议未收敛前任何变更都是负资产）；②允许只读调研——web 搜索、读文档、查台账、拉数据、跑只读探针命令，为你的判断取证；③执行入口——合议落定后由 CEO 散会落单，执行走工单通道，群聊只作会场。'
  const isReviewer = /independent-reviewer/i.test(String(member.seat || ''))
  const roleLine = isReviewer
    ? `[AMM OPC 合议群「${room.name}」] 你是独立评审席（裁判，非辩手）。${modeNote} 你的唯一职责：只输出你将如何审查最终方案的判据——什么情况 hold、需要什么证据件、哪些数字你会独立重算。不评价任何席位方案的对错、不给改进建议、不参与口径拉锯（判据是抽象规则，审查在方案落定后独立进行）。`
    : `[AMM OPC 合议群「${room.name}」] 你是 @${member.seat}（${member.label}），${member.machine === 'pc1' ? 'PC1 执行团队的智能体' : 'AMM 总经办席位'}，正在参与多智能体合议。${modeNote}`
  return [
    roleLine,
    '',
    '自你上次发言后的新消息（最早在前）：',
    lines || '  （暂无）',
    '',
    '规则：① 直接面向议题，给出你职责视角的判断，简短（不超过 3 句）；',
    '② 若你没有新增内容要补充，只回 `(pass)` 跳过，不要客套；',
    '③ 要点名某位席位回应用 @席位代号；',
    '④ 不要泄露你与我的任何私聊内容；',
    '⑤ 每条发言力求可执行、可裁决，避免空话。',
  ].join('\n')
}

// ── PC2 成员会话管理（懒创建隐藏房间会话，复用 office 的 requestForBot 路由）──
// 网关双 id 语义：session.create 返回 {session_id: 运行时 id, stored_session_id: 持久 key}；
// session.resume 只认 stored key（拿运行时 id 去 resume 必吃 4007）。房间记录里只存 stored。
async function ensureOsSession(member, roomId) {
  const room = getRoom(roomId)
  const existing = room && room.sessions && room.sessions[member.key]
  if (existing) {
    try {
      const r = await requestForBot(member, 'session.resume', { session_id: existing })
      if (r && (r.runtime || r.session_id || r.id)) return { stored: existing, runtime: r.runtime || r.session_id || r.id }
    } catch (e) { /* 失效：标题兜底 */ }
    // 标题兜底：ws_orphan_reap 后 stored id 失效，但会话实体常仍在——按标题找回
    // （必须 include_hidden：房间会话全是 hidden:true 创建，缺参列表永远查不到 → 每轮误重建）
    try {
      const lst = await requestForBot(member, 'session.list', { limit: 50, include_hidden: true })
      const rows = (lst && (lst.sessions || lst.rows || lst.items)) || []
      const want = 'OS-Group: ' + roomId
      const hit = rows.find(x => x && String(x.title || '').includes(want))
      if (hit) {
        const sid = hit.stored_session_id || hit.session_id || hit.id || (hit.session && hit.session.id)
        if (sid) {
          const rr = await requestForBot(member, 'session.resume', { session_id: sid }).catch(() => null)
          patchRoom(roomId, r => { r.sessions[member.key] = sid; return r })
          return { stored: sid, runtime: (rr && rr.runtime) || sid }
        }
      }
    } catch { /* 走 create */ }
    patchRoom(roomId, r => { delete r.sessions[member.key]; return r })
  }
  const created = await requestForBot(member, 'session.create', {
    profile: member.name, title: 'OS-Group: ' + roomId, hidden: true, room_plumbing: true, follow_profile_config: true,
  })
  const runtimeId = created && (created.session_id || created.id || (created.session && created.session.id))
  const storedId = (created && (created.stored_session_id || created.stored_id)) || runtimeId
  patchRoom(roomId, r => { r.sessions[member.key] = storedId; return r })
  return { stored: storedId, runtime: (created && created.runtime) || runtimeId }
}

// ── 等成员发言完成：事件快路径 + resume 轮询兜底 ──
// waiter 必须在 prompt.submit 之前注册（同步完成帧也丢不了）；双键匹配（runtime + stored，事件帧带哪个都能中）。
// 网关终态失败发的是裸 error 帧（不是 message.error）；message.complete 也可能载 payload.status==='error'——都算显式失败。
const osTurnWaiters = new Map() // runtimeId -> {key, sids:[runtime,stored], resolve}
function osNewWaiter(sessionIds) {
  const key = String(sessionIds.runtime)
  let resolveFn = null
  const promise = new Promise(res => { resolveFn = res })
  const waiter = {
    key,
    sids: [sessionIds.runtime, sessionIds.stored].filter(Boolean).map(String),
    resolve: (res) => { osTurnWaiters.delete(key); resolveFn(res) },
  }
  osTurnWaiters.set(key, waiter)
  return { waiter, promise }
}
function osHandleGatewayEvent(ev) {
  if (!ev || !ev.type) return
  // ws_orphan_reap：网关回收孤儿会话并重配 id——命中我们的成员会话时立即清记录（下次发言自动重建）
  if (ev.type === 'session.reclaimed') {
    try {
      const p = ev.payload || {}
      const ids = [p.session_id, p.stored_session_id].filter(Boolean).map(String)
      if (ids.length) {
        const rooms = $osRooms.get() || []
        let hit = false
        const next = rooms.map(r => {
          const sess = r.sessions || {}
          const keys = Object.keys(sess).filter(k => ids.includes(String(sess[k])))
          if (!keys.length) return r
          hit = true
          const ns = { ...sess }
          for (const k of keys) delete ns[k]
          return { ...r, sessions: ns }
        })
        if (hit) { $osRooms.set(next); saveOsRooms() }
      }
    } catch { /* 尽力 */ }
    return
  }
  if (ev.type === 'message.delta') {
    // 进度可见（真假死一眼可辨）：节流 2s/席，累计已生成字数到 engine.progress
    const sid = ev.session_id || (ev.payload && ev.payload.session_id)
    const chunk = (ev.payload && (ev.payload.delta || ev.payload.text)) || ''
    if (!sid || !chunk) return
    const now = Date.now()
    for (const r of $osRooms.get() || []) {
      const seatKey = Object.keys(r.sessions || {}).find(k => String(r.sessions[k]) === String(sid))
      if (!seatKey) continue
      const cur = ((r.engine || {}).progress || {})[seatKey] || { at: 0, chars: 0 }
      if (now - cur.at < 2000) return
      patchRoom(r.roomId, x => { x.engine.progress = { ...(x.engine.progress || {}), [seatKey]: { at: now, chars: cur.chars + String(chunk).length } }; return x })
      return
    }
    return
  }
  if (ev.type !== 'message.complete' && ev.type !== 'message.error' && ev.type !== 'error') return
  const sid = ev.session_id || (ev.payload && (ev.payload.session_id || ev.payload.stored_session_id))
  if (!sid) return
  if (typeof process !== 'undefined' && process.env && process.env.OSG_DEBUG) {
    console.error('[osHandle]', sid, ev.type, 'waiters=', [...osTurnWaiters.keys()].join(','))
  }
  for (const [key, w] of osTurnWaiters) {
    if ((w.sids ? w.sids.includes(String(sid)) : key === String(sid)) && typeof w.resolve === 'function') {
      const failed = ev.type !== 'message.complete' || !!(ev.payload && ev.payload.status === 'error')
      if (!failed) w.resolve({ ok: true, text: (ev.payload && (ev.payload.text || ev.payload.reply)) || '' })
      else w.resolve({ ok: false, error: (ev.payload && (ev.payload.error || ev.payload.message)) || ev.type })
    }
  }
}
function osWaitForTurn(member, roomId, sessionIds, baselineCount, waiter, waiterPromise, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    let resumeFails = 0
    const finish = (res) => {
      if (done) return
      done = true
      clearInterval(poll); clearTimeout(to)
      osTurnWaiters.delete(waiter.key)
      resolve(res)
    }
    waiterPromise.then(res => finish(res))   // 事件快路径
    const poll = setInterval(async () => {
      try {
        const r = await requestForBot(member, 'session.resume', { session_id: sessionIds.stored })
        resumeFails = 0
        const msgs = (r && (r.messages || r.history)) || []
        const fresh = msgs.slice(baselineCount)
        const lastAssistant = [...fresh].reverse().find(m => m && (m.role === 'assistant' || m.kind === 'assistant') && (m.text || m.content))
        if (lastAssistant) finish({ ok: true, text: lastAssistant.text || lastAssistant.content })
      } catch (e) {
        // 不再静默吞错空转：连续 3 次 resume 失败 = 会话实体没了，显式报错（含 session 字样 → 外层自动重建重试一次）
        resumeFails++
        if (resumeFails >= 3) finish({ ok: false, error: 'session lost: ' + String(e && e.message || e) })
      }
    }, OS_RESUME_POLL_MS)
    const to = setTimeout(() => {
      // 超时即 interrupt 杀僵尸轮次——不杀的话下一投会撞 busy 排队
      try { requestForBot(member, 'session.interrupt', { session_id: sessionIds.runtime }).catch(() => null) } catch { /* 尽力 */ }
      finish({ ok: false, error: 'timeout' })
    }, timeoutMs || OS_TURN_TIMEOUT_MS)
  })
}

// ── 给单个成员投递一轮发言并取回复 ──
async function osMemberSpeak(roomId, member, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || OS_TURN_TIMEOUT_MS
  const room = getRoom(roomId)
  if (!room) return { ok: false, error: 'room gone' }
  const newMsgs = osNewMessages(room, member.key)
  const prompt = buildOsTurnPrompt(room, member, newMsgs)
  patchRoom(roomId, r => { r.engine.currentSeat = member.seat; return r })

  if (member.machine === 'pc1') {
    // 跨机：SSH CLI 精准通道——直达该席位本人（hermes -p <席位> chat -q），单句回执匹配轮转协议
    try {
      const resp = await fetch(API + '/api/action/a2a-send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: String(member.seat || '').replace(/^pc1\//, ''), text: `[合议群「${room.name}」@${member.seat}] ` + prompt }),
      }).then(r => r.json())
      const text = resp && (resp.reply || resp.text || '')
      if (resp && resp.ok === false) return { ok: false, error: resp.error || '跨机通道失败' }
      return { ok: true, text: String(text || '').slice(0, 800) }
    } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  }

  // PC2：隐藏房间会话（失效自动重建，重试一次）
  const attempt = async () => {
    const sess = await ensureOsSession(member, roomId)
    const resume0 = await requestForBot(member, 'session.resume', { session_id: sess.stored }).catch(() => null)
    const msgs0 = (resume0 && (resume0.messages || resume0.history)) || []
    // 迟到回收：上轮失败/超时后晚到的回复先补登入账，并把它纳入 baseline——防止被错认为本轮答案
    const room0 = getRoom(roomId)
    const lateMap = (room0 && room0.engine && room0.engine.pendingLate) || null
    const lateFrom = lateMap && typeof lateMap[member.key] === 'number' ? lateMap[member.key] : null
    if (lateFrom !== null) {
      const late = [...msgs0.slice(lateFrom)].reverse().find(m => m && (m.role === 'assistant' || m.kind === 'assistant') && (m.text || m.content))
      if (late) appendOsLog(roomId, { from: { kind: 'member', seat: member.seat, label: member.label }, round: (room0.engine || {}).round || 0,
        text: '（迟到补登）' + String(late.text || late.content).slice(0, 1200) })
      patchRoom(roomId, r => { if (r.engine.pendingLate) delete r.engine.pendingLate[member.key]; return r })
    }
    const baseline = msgs0.length
    const { waiter, promise } = osNewWaiter(sess)   // 先注册 waiter，再 submit
    return await withBotLease(member, async () => {
      let submitRes
      try {
        submitRes = await requestForBot(member, 'prompt.submit', { session_id: sess.runtime, text: prompt })
        // 排队/改道 = 该会话有僵尸轮次没死透：interrupt 后重投一次；仍排队 → 显式报席位忙碌
        if (submitRes && (submitRes.status === 'queued' || submitRes.status === 'redirected')) {
          await requestForBot(member, 'session.interrupt', { session_id: sess.runtime }).catch(() => null)
          submitRes = await requestForBot(member, 'prompt.submit', { session_id: sess.runtime, text: prompt })
          if (submitRes && (submitRes.status === 'queued' || submitRes.status === 'redirected')) {
            osTurnWaiters.delete(waiter.key)
            return { ok: false, error: '席位忙碌（排队未消化）' }
          }
        }
      } catch (e) {
        osTurnWaiters.delete(waiter.key)
        throw e
      }
      const res = await osWaitForTurn(member, roomId, sess, baseline, waiter, promise, timeoutMs)
      // 失败时记下基线——下轮先 drain 迟到回复再投新 prompt（防 stale 错认）
      if (!res.ok) patchRoom(roomId, r => { r.engine.pendingLate = { ...(r.engine.pendingLate || {}), [member.key]: baseline }; return r })
      return res.ok ? { ok: true, text: String(res.text || '').slice(0, 1200) } : { ok: false, error: res.error || 'no reply' }
    })
  }
  try {
    let res = await attempt()
    // 超时类失败自动重试一次（interrupt 已在超时处理里杀过僵尸轮）——600s 仍不够时由重试吸收网络抖动/偶发慢响应
    if (!res.ok && /timeout/i.test(res.error || '')) {
      appendOsLog(roomId, { from: { kind: 'member', seat: member.seat, label: member.label }, sys: true,
        text: '（@' + member.seat + ' 首轮超时，自动重试一次）', round: (getRoom(roomId).engine || {}).round || 0 })
      res = await attempt()
    }
    if (!res.ok && /session/i.test(res.error || '')) {
      patchRoom(roomId, r => { delete r.sessions[member.key]; return r }) // 会话失效：清记录强制重建
      appendOsLog(roomId, { from: { kind: 'member', seat: member.seat, label: member.label }, sys: true,
        text: '（@' + member.seat + ' 会话失效，已自动重建重试）', round: 0 })
      res = await attempt()
    }
    return res.ok ? res : { ok: false, error: res.error || 'no reply' }
  } catch (e) {
    const msg = String(e && e.message || e)
    if (/session/i.test(msg)) {
      try {
        patchRoom(roomId, r => { delete r.sessions[member.key]; return r })
        const res = await attempt()
        return res.ok ? res : { ok: false, error: res.error || 'no reply' }
      } catch (e2) { return { ok: false, error: msg } }
    }
    return { ok: false, error: msg }
  }
}

// ── 轮转引擎主循环 ──
const osRunning = new Set() // roomId 防重入
async function runOsRounds(roomId, opts) {
  if (osRunning.has(roomId)) return
  osRunning.add(roomId)
  const extraRounds = (opts && opts.extraRounds) || 0
  try {
    let room = getRoom(roomId)
    if (!room) return
    const startRound = (room.engine && room.engine.round) || 0
    const maxRounds = Math.min((room.maxRounds || OS_DEFAULT_ROUNDS) + extraRounds, OS_MAX_ROUNDS_LIMIT * 2)
    patchRoom(roomId, r => { r.engine.running = true; r.engine.settled = false; r.engine.epoch = (r.engine.epoch || 0) + 1; return r })
    const epoch = (getRoom(roomId).engine || {}).epoch

    let anySpokeThisEpoch = false
    for (let round = startRound; round < maxRounds; round++) {
      room = getRoom(roomId)
      if (!room || !room.engine || !room.engine.running) break      // 被 stop
      if ((room.engine.epoch || 0) !== epoch) break                 // 新一轮已接管
      patchRoom(roomId, r => { r.engine.round = round; return r })

      const lastUserMsg = [...(room.log || [])].reverse().find(m => m.from.kind === 'user')
      const responders = parseOsMentions(lastUserMsg ? lastUserMsg.text : '', room.members || [])
      if (!responders.length) break

      let spokeInRound = 0
      const directed = lastUserMsg && /@\S/.test(lastUserMsg.text)
      const guard = () => {
        room = getRoom(roomId)
        return room && room.engine && room.engine.running && (room.engine.epoch || 0) === epoch
      }
      // 入账：watermark 仅在发言成功时推进（失败不推进 → 下一轮自动重发该批消息，不盲续）
      const postResult = (member, res) => {
        if (res.ok) patchRoom(roomId, r => { r.watermarks[member.key] = (r.log || []).length; return r })
        if (res.ok && !isOsPass(res.text)) {
          appendOsLog(roomId, { from: { kind: 'member', seat: member.seat, label: member.label }, text: res.text, round })
          anySpokeThisEpoch = true
          return 1
        }
        if (!res.ok) {
          appendOsLog(roomId, { from: { kind: 'member', seat: member.seat, label: member.label },
            text: '（发言失败：' + (res.error || '未知') + '）', round, sys: true })
        }
        return 0
      }
      if (directed) {
        // 定向：按 @mention 出现顺序串行（后发言者能看到先发言者的本轮立场，路由依赖场景）
        // 指名任务（终裁/执行清单）是大上下文长输出——双倍超时预算（09-20 CEO 终裁 297s 被掐实证）
        for (const member of responders) {
          if (!guard()) break
          spokeInRound += postResult(member, await osMemberSpeak(roomId, member, { timeoutMs: OS_DIRECTED_TIMEOUT_MS }))
        }
      } else {
        // 全员：chunk 并行执行、组内乱序完成后按成员序入账
        // （流畅性：一轮 ≈ ⌈n/3⌉ × 单席时长而非各席之和；顺序性：log 发言顺序恒等于成员序）
        for (let i = 0; i < responders.length; i += OS_PARALLEL_CHUNK) {
          if (!guard()) break
          const chunk = responders.slice(i, i + OS_PARALLEL_CHUNK)
          const results = await Promise.all(chunk.map(m => osMemberSpeak(roomId, m).then(res => ({ member: m, res }))))
          for (const { member, res } of results) {
            if (!guard()) break
            spokeInRound += postResult(member, res)
          }
        }
      }
      if (spokeInRound === 0) break  // 全员 pass → 提前 settled
    }
    patchRoom(roomId, r => { r.engine.running = false; r.engine.settled = true; r.engine.currentSeat = null; return r })
    try { host.notify && host.notify(`合议「${(getRoom(roomId) || {}).name || roomId}」已落定`) } catch {}
  } finally {
    osRunning.delete(roomId)
  }
}
function stopOsRounds(roomId) {
  patchRoom(roomId, r => { r.engine.running = false; r.engine.settled = true; r.engine.currentSeat = null; return r })
}
function appendOsLog(roomId, msg) {
  patchRoom(roomId, r => {
    const log = [...(r.log || []), { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at: Date.now(), ...msg }]
    r.log = log.length > OS_LOG_LIMIT ? log.slice(log.length - OS_LOG_LIMIT) : log  // retention
    return r
  })
}

// ── 创建 / 发送 ──
function createOsRoom({ name, members, maxRounds, source }) {
  const room = {
    roomId: mintOsRoomId(), name: name || '合议 ' + new Date().toLocaleDateString('zh-CN'),
    members: osSortMembers(members.slice(0, OS_MAX_MEMBERS)), maxRounds: Math.max(1, Math.min(maxRounds || OS_DEFAULT_ROUNDS, OS_MAX_ROUNDS_LIMIT)),
    mode: 'ASK',
    source: source || { kind: 'manual' },   // 来源可溯：{kind:'proposal'|'workorder'|'manual', id}——房间从哪来的一眼可见
    log: [], watermarks: {}, sessions: {}, engine: { epoch: 0, running: false, settled: false, round: 0, currentSeat: null, pendingLate: {} },
    createdAt: Date.now(), lastActiveAt: Date.now(),
  }
  $osRooms.set([...(($osRooms.get() || [])), room])
  saveOsRooms()
  return room
}
function sendOsUserMessage(roomId, text) {
  appendOsLog(roomId, { from: { kind: 'user', seat: 'boss', label: '峰哥' }, text })
  runOsRounds(roomId)
}

// ── 群管理：重命名 / 追加成员 / 删除（数据层全自主，删除时收尾隐藏成员会话）──
function renameOsRoom(roomId, name) {
  const n = String(name || '').trim()
  if (!n) return false
  patchRoom(roomId, r => { r.name = n.slice(0, 64); return r })
  return true
}

function addOsRoomMembers(roomId, newMembers) {
  const room = getRoom(roomId)
  if (!room) return { added: 0 }
  const have = new Set((room.members || []).map(m => m.key))
  const add = (newMembers || []).filter(m => m && m.key && !have.has(m.key))
  if (!add.length) return { added: 0 }
  let added = 0
  patchRoom(roomId, r => {
    for (const m of add) {
      if (r.members.length >= OS_MAX_MEMBERS) break
      r.members.push(m)
      r.watermarks[m.key] = 0 // 新成员从现有历史接入（协议 prompt 只带最近 24 行上下文）
      added++
    }
    r.members = osSortMembers(r.members)   // 保持发言顺序约束（评审前置、CEO 压轴）
    return r
  })
  return { added }
}

async function deleteOsRoom(roomId) {
  const room = getRoom(roomId)
  if (!room) return false
  if (room.engine && room.engine.running) stopOsRounds(roomId)
  for (const [key, sid] of Object.entries(room.sessions || {})) {
    try {
      const m = (room.members || []).find(mm => mm.key === key)
      if (m && m.machine === 'pc2' && typeof host.setPersistedSessionHidden === 'function') {
        await host.setPersistedSessionHidden(sid, { sessionId: sid, profile: m.seat || m.name, hidden: true })
      }
    } catch { /* 尽力而为 */ }
  }
  $osRooms.set(($osRooms.get() || []).filter(r => r.roomId !== roomId))
  saveOsRooms()
  return true
}

// ── 合议与台账打通 ──
function osConcludeToProposal(roomId) {
  const room = getRoom(roomId)
  if (!room) return null
  const memberMsgs = (room.log || []).filter(m => m.from.kind === 'member' && !m.sys)
  // 结论源优先 CEO 终裁（与归档审查包口径一致），无 CEO 发言则前 8 条摘要兜底
  const ceoFinal = [...memberMsgs].reverse().find(m => m.from.seat === 'ceo')
  const digest = memberMsgs.slice(-8).map(m => `@${m.from.seat}: ${m.text}`).join('\n')
  const summary = ceoFinal ? '【CEO 终裁】' + ceoFinal.text + '\n\n【合议摘要】\n' + digest : digest
  return {
    title: '合议结论：' + stripOsTitlePrefix(room.name),
    targetAnchor: '合议群 ' + room.roomId,
    proposerSeat: 'ceo',
    priority: 'P2',
    fiveItems: summary.slice(0, 1500),
  }
}

// 来源去重：同一提案/工单已有合议群 → 跳转不新建（防「合议：合议结论：…」嵌套房）
function osFindRoomBySource(kind, id) {
  if (!id) return null
  return ($osRooms.get() || []).find(r => r.source && r.source.kind === kind && r.source.id === id) || null
}

// ── 外部编排合议回灌（自举通道）：快照服务上的议题载荷 → 真实合议群房间 ──
// 09-20 峰哥裁定：自举合议必须在群聊里原生轮转，CLI 广播式编排只算 R1/R2 素材——
// 回灌为房间历史（标注通道差异），CEO 终裁起由引擎原生接跑（autoResume 无人值守）。
async function importBootstrapRoom() {
  try {
    const pay = await fetch(API + '/api/bootstrap/room-payload').then(r => r.json()).catch(() => null)
    if (!pay || !pay.bootstrapId || !Array.isArray(pay.entries)) return
    const dup = osFindRoomBySource('bootstrap', pay.bootstrapId)
    if (dup) return dup   // 幂等：已导入（含 register 时已消费真实载荷的场景）——返回既有房间，不重复建
    const members = osSortMembers(SEATS.map(s => ({ key: 'pc2:' + s, name: s, seat: s, label: s, machine: 'pc2' })))
    const room = createOsRoom({ name: pay.roomName || '外部合议', members, maxRounds: 3, source: { kind: 'bootstrap', id: pay.bootstrapId } })
    appendOsLog(room.roomId, { from: { kind: 'user', seat: 'boss', label: '峰哥' }, round: 0,
      text: '【自举合议·议题】' + (pay.topicBrief || pay.roomName || '') + '。议题全文见 factory_assets/amm-opc-decision-hub/bootstrap/。以下 R1/R2 经外部编排通道完成（非本群原生发言，通道差异如实标注），自 CEO 终裁起在本群原生轮转。' })
    let lastRound = 0
    for (const e of pay.entries) {
      if (e.round !== lastRound) {
        appendOsLog(room.roomId, { from: { kind: 'member', seat: 'system', label: '系统' }, sys: true, round: e.round - 1,
          text: '—— Round ' + e.round + '（外部编排通道转写）——' })
        lastRound = e.round
      }
      appendOsLog(room.roomId, { from: { kind: 'member', seat: e.seat, label: e.seat }, round: e.round - 1, text: e.text })
    }
    appendOsLog(room.roomId, { from: { kind: 'user', seat: 'boss', label: '峰哥' }, round: 2,
      text: '【峰哥】R1/R2 已完成（外部编排通道转写）。@ceo 请压轴终裁五件套：【方案】【拆解要点】【验收标准与清单（UX 类标「需峰哥」）】【证据级】【动作量】。' })
    const logLen = (getRoom(room.roomId).log || []).length
    patchRoom(room.roomId, r => {
      for (const m of r.members) r.watermarks[m.key] = (m.seat === 'ceo' ? 0 : logLen)   // CEO 从头见全部，其余已「看过」
      r.engine.round = 2; r.engine.settled = false; r.autoResume = true
      return r
    })
    setTimeout(() => { try { runOsRounds(room.roomId) } catch {} }, 3000)
    return room
  } catch (e) {
    try { console.error('[importBootstrapRoom]', e && e.message || e) } catch {}
    /* 快照服务不可达：下次加载重试 */
  }
}

// 登记结论为提案（幂等核心，UI 按钮调它）：房间级幂等 + 服务端去重双保险；失败明示原因
async function osRegisterConclusion(roomId) {
  const room = getRoom(roomId)
  if (!room) return { ok: false, error: 'room gone' }
  if (room.proposalId) return { ok: true, id: room.proposalId, existed: true }   // 本房间已登记过
  // 服务端去重：旧版可能已为本房间建过提案（targetAnchor 匹配即认领，不重复登记）
  const list = await fetch(API + '/api/ledger/proposals').then(r => r.json()).catch(() => null)
  const rows = Array.isArray(list) ? list : ((list && (list.proposals || list.rows)) || [])
  const dup = rows.find(p => p && p.targetAnchor === '合议群 ' + roomId && p.currentStage !== '已废止')
  if (dup) {
    patchRoom(roomId, rm => { rm.proposalId = dup.proposalId; return rm })
    appendOsLog(roomId, { from: { kind: 'member', seat: 'system', label: '系统' }, sys: true, round: 0,
      text: '✅ 本房间的结论提案已存在（' + dup.proposalId + '），已自动关联，不重复登记。下一步见下方指引。' })
    return { ok: true, id: dup.proposalId, existed: true }
  }
  const payload = osConcludeToProposal(roomId)
  if (!payload) return { ok: false, error: 'room gone' }
  const r = await fetch(API + '/api/action/proposal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json()).catch(() => null)
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || '快照服务不可达（8901）' }
  patchRoom(roomId, rm => { rm.proposalId = r.id; return rm })
  appendOsLog(roomId, { from: { kind: 'member', seat: 'system', label: '系统' }, sys: true, round: 0,
    text: '✅ 结论已登记为提案 ' + r.id + '。下一步：① 下方「去悬决面板」查看/推进；② 「派单给 CEO 执行」由 CEO 拆解为席位工单下达。' })
  return { ok: true, id: r.id }
}

// 派单给 CEO（幂等）：建 1 张「拆解执行」工单 + 送达并等回执（指挥链：执行单经 CEO 下达，不越级直派席位）
// 三态如实：已回执 / 已送达等回执 / 送达未确认——绝不静默吞（09-20 实锤：fire-and-forget 让 UI 说谎）
async function osDispatchToCeo(roomId, opts) {
  const room = getRoom(roomId)
  if (!room) return { ok: false, error: 'room gone' }
  if (!room.proposalId) return { ok: false, error: '请先登记结论为提案' }
  if (room.workOrderId) return { ok: true, id: room.workOrderId, existed: true }
  const payload = osConcludeToProposal(roomId)
  const wo = await fetch(API + '/api/action/workorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    title: '拆解执行：' + stripOsTitlePrefix(room.name),
    assignedSeat: 'ceo',
    priority: 'P1',
    source: '提案 ' + room.proposalId + '（合议群 ' + roomId + '）',
    operator: '峰哥',
  }) }).then(r => r.json()).catch(() => null)
  if (!wo || !wo.ok) return { ok: false, error: (wo && wo.error) || '快照服务不可达（8901）' }
  patchRoom(roomId, rm => { rm.workOrderId = wo.id; return rm })
  const text = '[AMM OPC 工单 ' + wo.id + ' · 合议执行拆解]\n提案：' + room.proposalId + '（' + payload.title + '）\n\n合议结论：\n' + payload.fiveItems + '\n\n【你的任务】按合议结论拆解为各席位工单并逐一送达（指挥链：执行单经你下达；子单 source 需含 ' + room.proposalId + '）。回执一行：「已受理」或「缺件：<缺什么>」。'
  const deliverFn = (opts && opts.deliver) || osDeliverAndAwait
  let delivery
  try { delivery = await deliverFn('ceo', text, 120000) } catch (e) { delivery = { ok: false, error: String(e && e.message || e) } }
  if (delivery && delivery.ok) {
    const line = String(delivery.reply || '').split('\n')[0].slice(0, 120)
    patchRoom(roomId, rm => { rm.dispatch = { workOrderId: wo.id, at: Date.now(), receipt: line }; return rm })
    appendOsLog(roomId, { from: { kind: 'member', seat: 'system', label: '系统' }, sys: true, round: 0,
      text: '✅ 已派单给 CEO：工单 ' + wo.id + '（拆解执行），CEO 已回执：' + line + '。到「执行追踪」页看全链路进度。' })
    try {
      await fetch(API + '/api/action/workorder-reply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workOrderId: wo.id, reply: '已送达且回执：' + line, repliedBy: 'os-desk' }) }).then(r => r.json()).catch(() => null)
    } catch { /* 尽力 */ }
  } else {
    const err = (delivery && delivery.error) || '送达未确认'
    patchRoom(roomId, rm => { rm.dispatch = { workOrderId: wo.id, at: Date.now(), receipt: null, error: err }; return rm })
    appendOsLog(roomId, { from: { kind: 'member', seat: 'system', label: '系统' }, sys: true, round: 0,
      text: '⚠️ 工单 ' + wo.id + ' 已创建，但送达未确认（' + err + '）。到「执行追踪」页可催办重发。' })
    try {
      await fetch(API + '/api/action/workorder-reply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workOrderId: wo.id, reply: '送达未确认：' + err, repliedBy: 'os-desk' }) }).then(r => r.json()).catch(() => null)
    } catch { /* 尽力 */ }
  }
  return { ok: true, id: wo.id, receipt: delivery && delivery.ok ? delivery.reply : null }
}

// 从提案/工单一键发起合议（悬决面板/任务面板「发起合议」按钮调用）
// 成员默认总经办 8 席（评审判据前置、CEO 压轴），议题=事项内容，切到群聊视图并启动轮转
function osStartRoomFromProposal(p) {
  const srcId = p.proposalId || p.workOrderId || null
  const kind = p.proposalId ? 'proposal' : 'workorder'
  const dup = osFindRoomBySource(kind, srcId)
  if (dup) {
    try { $osActiveRoom.set(dup.roomId); $view.set('chat') } catch { /* 视图切换失败不阻塞 */ }
    try { host.notify && host.notify('该事项已有合议群「' + dup.name + '」，已为你跳转（不重复建群）') } catch {}
    return dup
  }
  const members = SEATS.map(s => ({ key: 'pc2:' + s, name: s, seat: s, label: s, machine: 'pc2' }))
  const title = stripOsTitlePrefix(p.title || p['事项'] || p.proposalId || p.workOrderId || '未命名事项')
  const anchor = p.targetAnchor || p['出处文件'] || ''
  const room = createOsRoom({ name: '合议：' + title, members, maxRounds: OS_DEFAULT_ROUNDS, source: srcId ? { kind, id: srcId } : { kind: 'manual' } })
  appendOsLog(room.roomId, { from: { kind: 'user', seat: 'boss', label: '峰哥' }, text: '【合议议题】' + title + (anchor ? '\n依据/目标锚：' + anchor : '') + '\n请各位从职责视角给出裁决建议（无补充可回 (pass)）。' })
  try { $osActiveRoom.set(room.roomId); $view.set('chat') } catch { /* 视图切换失败不阻塞合议 */ }
  runOsRounds(room.roomId)
  return room
}

// ══ 记忆投递直通通道（绕过 office job 闸门——纪要与审查包是"记忆投递"不是"任务派发"，
// 走 sendTask 会被 jobAllowsSubmission 静默拦截：通知先把 job 激活，审查包就永远发不出）══
async function osDeliverToSeat(seat, text) {
  const bot = { name: seat }
  const chat = await ensureBotChat(bot)
  if (!chat || !chat.runtime) throw new Error('无法打开席位会话')
  await withBotLease(bot, async () => {
    await requestForBot(bot, 'prompt.submit', { session_id: chat.runtime, text })
  })
  return true
}

// ── 送达回执闭环：投递后轮询席位会话拿 assistant 回执（「已受理/缺件」契约）——
// 之前 fire-and-forget，投递失败被静默吞、UI 照写「已送达」（09-20 实锤）══
async function osAwaitReceipt(member, chatRuntime, baseLen, timeoutMs, pollMs) {
  const step = pollMs || 5000
  const limit = timeoutMs || 120000
  const deadline = Date.now() + limit
  for (;;) {
    const r = await requestForBot(member, 'session.resume', { session_id: chatRuntime }).catch(() => null)
    const msgs = (r && (r.messages || r.history)) || []
    const rep = [...msgs.slice(baseLen)].reverse().find(m => m && (m.role === 'assistant' || m.kind === 'assistant') && (m.text || m.content))
    if (rep) return { ok: true, reply: String(rep.text || rep.content).slice(0, 300) }
    if (Date.now() + step > deadline) return { ok: false, error: '送达超时（' + Math.round(limit / 1000) + 's 无回执）' }
    await new Promise(res => setTimeout(res, step))
  }
}

async function osDeliverAndAwait(seat, text, timeoutMs, pollMs) {
  const bot = { name: seat }
  const chat = await ensureBotChat(bot)
  if (!chat || !chat.runtime) throw new Error('无法打开席位会话')
  const before = await requestForBot(bot, 'session.resume', { session_id: chat.runtime }).catch(() => null)
  const baseLen = ((before && (before.messages || before.history)) || []).length
  await withBotLease(bot, async () => {
    await requestForBot(bot, 'prompt.submit', { session_id: chat.runtime, text })
  })
  return osAwaitReceipt(bot, chat.runtime, baseLen, timeoutMs, pollMs)
}

// 催办：对在途工单重发一行催办并等回执（幂等——一次一催，不轰炸）
async function osNudgeDispatch(roomId, opts) {
  const room = getRoom(roomId)
  if (!room || !room.workOrderId) return { ok: false, error: '无在途工单可催' }
  const payload = osConcludeToProposal(roomId)
  const text = '[催办 · AMM OPC 工单 ' + room.workOrderId + ' · 合议执行拆解]\n提案：' + (room.proposalId || '') + '\n\n合议结论：\n' + (payload ? payload.fiveItems : '') + '\n\n【催办】请回执一行「已受理」或「缺件：<缺什么>」，并尽快拆解为席位工单。'
  const deliverFn = (opts && opts.deliver) || osDeliverAndAwait
  let delivery
  try { delivery = await deliverFn('ceo', text, 120000) } catch (e) { delivery = { ok: false, error: String(e && e.message || e) } }
  if (delivery.ok) {
    const line = String(delivery.reply || '').split('\n')[0].slice(0, 120)
    appendOsLog(roomId, { from: { kind: 'member', seat: 'system', label: '系统' }, sys: true, round: 0,
      text: '✅ 催办已送达，CEO 回执：' + line })
    try {
      await fetch(API + '/api/action/workorder-reply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workOrderId: room.workOrderId, reply: '催办回执：' + line, repliedBy: 'os-desk' }) }).then(r => r.json()).catch(() => null)
    } catch { /* 尽力 */ }
    return { ok: true, reply: delivery.reply }
  }
  return { ok: false, error: delivery.error || '催办未确认' }
}

// ══ 合议纪要归档（三层沉淀：企业台账 + 成员持久记忆 + PC1 文件层）══
async function archiveOsDeliberation(roomId) {
  const room = getRoom(roomId)
  if (!room) return { error: 'room gone' }
  if (room.archivedId) return { ok: true, id: room.archivedId, existed: true }   // 幂等：重复点击/重复落定包不产生重复 DEL
  const userFirst = (room.log || []).find(m => m.from.kind === 'user')
  const entries = (room.log || []).filter(m => m.from.kind === 'member' && !m.sys).map(m => ({ seat: m.from.seat, text: m.text }))
  const participants = [...new Set(entries.map(e => e.seat))]
  const payload = { roomId: room.roomId, topic: userFirst ? userFirst.text.slice(0, 200) : room.name, participants, entries }
  const resp = await fetch(API + '/api/action/deliberation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }).then(r => r.json()).catch(() => null)
  if (!resp || !resp.ok) return { error: (resp && resp.error) || '归档失败' }
  const did = resp.id
  patchRoom(roomId, r => { r.archivedId = did; return r })   // 幂等标记：后续重复调用直接返回
  // markdown 纪要 → 写 PC1 工作目录（执行层上下文文件）
  const md = ['# 合议纪要 ' + did, '', '- 议题：' + payload.topic, '- 时间：' + new Date().toISOString().slice(0, 16).replace('T', ' '),
    '- 参与：' + (participants.join(', ') || '（无成员发言）'), '', '## 发言记录',
    ...entries.map(e => '- @' + e.seat + '：' + e.text), '',
    '（由 AMM OPC OS 合议群自动归档；后续相关任务请先读本纪要恢复上下文）', ''].join('\n')
  const w = await fetch(API + '/api/action/pc1-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: did + '.md', content: md }),
  }).then(r => r.json()).catch(() => null)
  // 通知 PC2 成员持久 Bot Chat（进入席位长期会话记忆）
  let notified = 0
  for (const m of room.members) {
    if (m.machine !== 'pc2') continue
    try {
      await osDeliverToSeat(m.seat, '[合议纪要 ' + did + '] 你参与了合议「' + room.name + '」，议题：' + payload.topic + '。纪要已归档' + (w && w.ok ? '，PC1 存档：' + w.path : '') + '。后续遇到相关任务请先回忆本次合议你的立场与结论。')
      notified++
    } catch { /* 尽力 */ }
  }
  // 审查包：独立评审席落定后独立审查（材料隔离——剥离全部合议过程发言，含 reviewer 自己的）
  let reviewSent = false
  const reviewer = (room.members || []).find(m => /independent-reviewer/i.test(String(m.seat || '')) && m.machine === 'pc2')
  const ceoFinals = (room.log || []).filter(m => m.from.kind === 'member' && m.from.seat === 'ceo' && !m.sys)
  if (reviewer && (ceoFinals.length || payload.topic)) {
    try {
      const pkg = [
        '[独立评审审查包 · ' + did + ']', '',
        '## 审查纪律（先读顺序固定）',
        '① 先读 OBJECTIVE 目标本（D:/hermes/constitution/OBJECTIVE.md）→ ② 原始证据（各席位落盘件，见纪要内出处）→ ③ 最后才读下方方案结论。',
        '关键数字独立重算后表态；hold 单须含「时限或指名解除人」至少其一。',
        '', '## 最终方案（CEO 终裁与裁决，剥离合议过程发言）',
        ...ceoFinals.map(m => '### ' + new Date(m.at || Date.now()).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '\\n' + m.text),
        '', '## 议题', payload.topic, '',
        '本包不含各席位合议期发言（独立性保护）。产出 hold/放行意见写入你的持久会话即可。',
      ].join('\\n')
      await osDeliverToSeat(reviewer.seat, pkg)
      reviewSent = true
    } catch { /* 尽力 */ }
  }
  appendOsLog(roomId, { from: { kind: 'member', seat: 'system', label: '系统' }, sys: true,
    text: '合议纪要已归档：' + did + (w && w.ok ? ' ｜ PC1 存档：' + w.path : '') + ' ｜ 已通知 ' + notified + ' 个 PC2 席位' + (reviewSent ? ' ｜ 审查包已送独立评审（材料隔离）' : '') })
  return { id: did, pc1: w, notified, reviewSent }
}

// ══ 工单送达（WP3 PC2 方向）：注入席位 Bot Chat，回执落账 ══
// 复用 office 的 sendTask（ensureBotChat + prompt.submit 同一通道）
async function deliverWorkorder(t) {
  const text = `[AMM OPC 工单 ${t.workOrderId}]\n任务：${t.title}\n优先级：${t.priority || 'P2'}\n时限：${t.deadline || '尽快'}\n【回执极简契约】只回一行：「已受理」或「缺件：<缺什么>」。交付物异步落盘。`
  try {
    await sendTask({ name: t.assignedSeat }, text)
    await fetch(API + '/api/action/workorder-reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workOrderId: t.workOrderId, reply: '已送达到 ' + t.assignedSeat + ' 会话', repliedBy: 'os-desk' }),
    }).then(r => r.json()).catch(() => null)
    try { host.notify && host.notify('工单 ' + t.workOrderId + ' 已送达 ' + t.assignedSeat) } catch {}
    return true
  } catch (e) {
    try { host.notifyError && host.notifyError('送达失败：' + (e && e.message || e)) } catch {}
    return false
  }
}

// ══ PC1 远程团队横条（办公室页顶部，WP2）══
// 数据源 /api/pc1/team（快照服务经 SSH 拉 PC1 hermes profile list，5 分钟缓存）
// 诚实边界：running 仅表示 PC1 网关在线，不代表正在干活
function Pc1TeamBar() {
  const { data, loading } = useFetch(API + '/api/pc1/team')
  const profiles = (data && data.profiles) || []
  const unreachable = !loading && (!data || data.unreachable)
  return jsxs('div', { className: 'pc1-team-bar', children: [
    jsxs('span', { className: 'pc1-team-label', children: ['PC1 远程团队'] }),
    unreachable ? jsxs('span', { className: 'pc1-team-down', children: ['不可达（SSH 断开）'] })
      : loading ? jsxs('span', { className: 'pc1-team-dim', children: ['加载中…'] })
      : profiles.map(p => jsxs('span', { className: 'pc1-team-chip', title: (p.model || '') + ' · ' + (p.status || ''), children: [
          jsxs('i', { className: 'pc1-dot' + (p.status === 'running' ? ' on' : '') }),
          jsxs('span', { children: [p.name] }),
        ] }, p.name)),
    jsxs('span', { className: 'pc1-team-note', children: ['在线≠在干活'] }),
  ] })
}

// ══ 输入助手（群聊 + 办公室 TaskBar 共用）══
// @提及补全 + / 命令面板 + 附件 attach 流
// 命令清单来自 hermes 源码（gateway/slash_commands* + desktop-slash-commands）：
// 插件输入框经 prompt.submit 透传 → agent 侧命令有效；桌面专属命令（/yolo /skin 等）不透传，不列入
const OS_SLASH_COMMANDS = [
  { cmd: '/compact', desc: '压缩当前会话上下文（上下文过长时用）' },
  { cmd: '/new', desc: '重置会话上下文（开新工作段）' },
  { cmd: '/status', desc: '查看当前会话状态' },
  { cmd: '/goal', desc: '设置 / 查看当前目标' },
  { cmd: '/model', desc: '切换本会话模型' },
  { cmd: '/memory', desc: '查看 / 管理长期记忆' },
  { cmd: '/skills', desc: '查看 / 管理技能' },
  { cmd: '/approvals', desc: '查看待审批项' },
  { cmd: '/rollback', desc: '回滚最近的文件改动' },
  { cmd: '/diff', desc: '查看改动 diff' },
  { cmd: '/busy', desc: '忙碌策略：queue / steer / interrupt' },
  { cmd: '/help', desc: '查看帮助' },
]

const $assist = atom(null) // {kind:'mention'|'slash', query, items, hli, apply, inputEl}
const $osAttach = atom(null) // {label, refText}

function osAssistClose() { $assist.set(null) }

// onChange 检测：光标前的 @token（提及）或起始 /token（命令）
function osAssistOnChange(text, inputEl, apply, members, onPick) {
  try {
    const caret = inputEl.selectionStart != null ? inputEl.selectionStart : text.length
    const before = text.slice(0, caret)
    // / 命令：必须是消息开头
    const slashM = /^\/([\w-]*)$/.exec(before)
    if (slashM) {
      const q = slashM[1].toLowerCase()
      const items = OS_SLASH_COMMANDS.filter(c => c.cmd.toLowerCase().startsWith('/' + q))
      if (items.length) {
        $assist.set({ kind: 'slash', query: slashM[0], items, hli: 0, apply, inputEl })
        return
      }
      osAssistClose(); return
    }
    // @ 提及：光标前最近的 @ 到光标
    const at = before.lastIndexOf('@')
    if (at >= 0) {
      const token = before.slice(at + 1)
      if (/^[\w\u4e00-\u9fa5-]*$/.test(token) && (at === 0 || /\s/.test(before[at - 1]))) {
        const q = token.toLowerCase()
        const items = (members || []).filter(m =>
          !q || m.seat.toLowerCase().includes(q) || String(m.label).toLowerCase().includes(q))
        if (items.length) {
          $assist.set({ kind: 'mention', query: token, at, items, hli: 0, apply, inputEl, onPick })
          return
        }
      }
    }
    osAssistClose()
  } catch { osAssistClose() }
}

function osAssistOnKey(e) {
  const a = $assist.get()
  if (!a || !a.items || !a.items.length) return
  if (e.key === 'ArrowDown') { e.preventDefault(); $assist.set({ ...a, hli: (a.hli + 1) % a.items.length }) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); $assist.set({ ...a, hli: (a.hli - 1 + a.items.length) % a.items.length }) }
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); osAssistPick(a, a.items[a.hli]) }
  else if (e.key === 'Escape') { e.preventDefault(); osAssistClose() }
}

function osAssistPick(a, item) {
  if (a.kind === 'mention' && typeof a.onPick === 'function') { a.onPick(item); osAssistClose(); return }
  const el = a.inputEl
  if (a.kind === 'mention') {
    const caret = el && el.selectionStart != null ? el.selectionStart : a.at + 1 + a.query.length
    const next = el ? (el.value.slice(0, a.at) + '@' + item.seat + ' ' + el.value.slice(caret)) : ('@' + item.seat + ' ')
    a.apply(next, a.at + item.seat.length + 2)
  } else {
    const next = el ? (item.cmd + ' ' + el.value.slice(el.selectionStart != null ? el.selectionStart : el.value.length)) : (item.cmd + ' ')
    a.apply(next, item.cmd.length + 1)
  }
  osAssistClose()
}

// 浮层：fixed 定位到输入框上方；hli 高亮 + 点击选中
function OsAssistLayer() {
  const a = useValue($assist)
  if (!a || !a.inputEl || !a.items || !a.items.length) return null
  let top = 200, left = 200
  try {
    const rect = a.inputEl.getBoundingClientRect()
    top = Math.max(8, rect.top - 8 - Math.min(a.items.length, 8) * 30)
    left = rect.left
  } catch { /* 保底 */ }
  return jsx('div', { className: 'osg-assist', style: { position: 'fixed', top, left, zIndex: 9800 }, children:
    a.items.slice(0, 8).map((item, i) => jsxs('button', {
      className: 'osg-assist-item' + (i === a.hli ? ' on' : ''),
      onMouseDown: e => { e.preventDefault(); osAssistPick(a, item) },
      children: [
        jsx('span', { className: 'osg-assist-main', children: [a.kind === 'mention' ? '@' + item.seat : item.cmd] }),
        jsx('span', { className: 'osg-assist-desc', children: [a.kind === 'mention' ? (item.label || item.machine || '') : item.desc] }),
      ],
    }, (a.kind === 'mention' ? item.key : item.cmd) + i))
  })
}

// 附件（办公室 TaskBar）：选择文件 → attach 到该 bot 的 Bot Chat → ref_text 写入输入框
async function osPickAttachment(bot, setText) {
  try {
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = async () => {
      const file = input.files && input.files[0]
      if (!file) return
      try {
        const isImage = /^image\//.test(file.type || '')
        const dataUrl = await new Promise((res, rej) => {
          const fr = new FileReader()
          fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(file)
        })
        // 先拿到该 bot 的 Bot Chat 会话（attach 需要 session_id）
        const chat = await ensureBotChat(bot)
        const sid = chat && (chat.runtime || chat.stored || chat.session_id)
        let refText = ''
        if (isImage) {
          const base64 = String(dataUrl).split(',')[1] || ''
          const r = await requestForBot(bot, 'image.attach_bytes', { session_id: sid, content_base64: base64, filename: file.name })
          if (!r || !r.attached) throw new Error((r && r.message) || '图片附加上传失败')
          refText = '[图片附件已上传: ' + ((r && r.path) || file.name) + ']\n'
        } else {
          const r = await requestForBot(bot, 'file.attach', { name: file.name, session_id: sid, data_url: dataUrl })
          if (!r || !r.attached || !r.ref_text) throw new Error((r && r.message) || '附件上传失败')
          refText = r.ref_text + '\n'
        }
        $osAttach.set({ label: file.name, refText })
        setText(prev => (refText + (prev || '')))
        try { host.notify && host.notify('附件已就绪：' + file.name) } catch {}
      } catch (e) {
        try { host.notifyError && host.notifyError('附件失败：' + (e && e.message || e)) } catch {}
      }
    }
    input.click()
  } catch (e) {
    try { host.notifyError && host.notifyError('无法打开文件选择器') } catch {}
  }
}
function OsRenameDialog({ room, onClose }) {
  const [name, setName] = useState(room.name)
  return jsxs('div', { className: 'osg-mask', onClick: onClose, children: [
    jsxs('div', { className: 'osg-dialog', onClick: e => e.stopPropagation(), children: [
      jsxs('div', { className: 'osg-dialog-title', children: ['重命名群聊'] }),
      jsx('label', { className: 'osg-field', children: [
        jsx('span', { children: ['群聊名称'] }),
        jsx('input', { value: name, onChange: e => setName(e.target.value),
          onKeyDown: e => { if (e.key === 'Enter' && name.trim()) { renameOsRoom(room.roomId, name); onClose() } } }),
      ] }),
      jsxs('div', { className: 'aod-btnrow', children: [
        jsxs('button', { className: 'aod-btn aod-btn-pri', disabled: !name.trim(), onClick: () => { renameOsRoom(room.roomId, name); onClose() }, children: ['保存'] }),
        jsxs('button', { className: 'aod-btn', onClick: onClose, children: ['取消'] }),
      ] }),
    ] }),
  ] })
}

function OsAddMembersDialog({ room, onClose }) {
  const rosterQuery = useRoster()
  const pc1 = useFetch(API + '/api/pc1/team')
  const [sel, setSel] = useState({})
  const have = new Set((room.members || []).map(m => m.seat))
  const profiles = (rosterQuery && rosterQuery.data && rosterQuery.data.profiles) || []
  const pc2Members = profiles.filter(p => p && p.name && !have.has(p.name)).map(p => ({ key: 'pc2:' + p.name, name: p.name, seat: p.name, label: p.title || p.name, machine: 'pc2' }))
  const pc1Members = ((pc1.data && pc1.data.profiles) || []).filter(p => p && p.name && !have.has('pc1/' + p.name)).map(p => ({ key: 'pc1:' + p.name, name: p.name, seat: 'pc1/' + p.name, label: 'PC1·' + (p.alias || p.name), machine: 'pc1' }))
  const all = [...pc2Members, ...pc1Members]
  const chosen = all.filter(m => sel[m.key])
  const add = () => {
    addOsRoomMembers(room.roomId, chosen)
    onClose()
  }
  return jsxs('div', { className: 'osg-mask', onClick: onClose, children: [
    jsxs('div', { className: 'osg-dialog', onClick: e => e.stopPropagation(), children: [
      jsxs('div', { className: 'osg-dialog-title', children: ['追加成员（已在群 ', room.members.length, ' / 上限 ', OS_MAX_MEMBERS, '）'] }),
      jsxs('div', { className: 'osg-field', children: [
        all.length === 0 ? jsxs('div', { className: 'osg-empty', children: ['没有可追加的成员——所有可用席位都已在群里。'] }) : null,
        jsxs('div', { className: 'osg-member-grid', children: all.map(m => jsxs('label', { className: 'osg-member' + (sel[m.key] ? ' on' : ''), children: [
          jsx('input', { type: 'checkbox', checked: !!sel[m.key], onChange: () => setSel(v => ({ ...v, [m.key]: !v[m.key] })) }),
          jsxs('span', { children: [m.label] }),
        ] }, m.key)) }),
      ] }),
      jsxs('div', { className: 'aod-btnrow', children: [
        jsxs('button', { className: 'aod-btn aod-btn-pri', disabled: !chosen.length, onClick: add, children: ['追加 ', chosen.length, ' 名成员'] }),
        jsxs('button', { className: 'aod-btn', onClick: onClose, children: ['取消'] }),
      ] }),
    ] }),
  ] })
}

// ══ Grill 拷问面板（吸收 grill-tab MIT 设计：ladder 随请求传、简报绝不代发）══
// $grill: {ctxKey, apply, draft0, text, ladder[], loading, question, recommended, options, category, done, reason, inputAnswer, error}
const $grill = atom(null)

async function osGrillStart(ctxKey, text, apply) {
  $grill.set({ ctxKey, apply, draft0: text, text, ladder: [], loading: true, inputAnswer: '' })
  const r = await fetch(API + '/api/assist/interrogate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ladder: [] }),
  }).then(r => r.json()).catch(e => ({ error: String(e) }))
  const g = $grill.get()
  if (!g || g.ctxKey !== ctxKey) return
  if (r.error) { $grill.set({ ...g, loading: false, error: r.error }); return }
  $grill.set({ ...g, loading: false, done: !!r.done, reason: r.reason || '', question: r.question || null,
    recommended: r.recommended || '', options: r.options || [], category: r.category || '', inputAnswer: '' })
}

async function osGrillSubmit(answer) {
  const g = $grill.get()
  if (!g || !g.question) return
  const ans = String(answer != null ? answer : g.inputAnswer || '').trim() || g.recommended || ''
  const ladder = [...g.ladder, { question: g.question, answer: ans, category: g.category, recommended: g.recommended }]
  $grill.set({ ...g, ladder, loading: true, inputAnswer: '', question: null })
  const r = await fetch(API + '/api/assist/interrogate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: g.text, ladder }),
  }).then(r => r.json()).catch(e => ({ error: String(e) }))
  const g2 = $grill.get()
  if (!g2 || g2.ctxKey !== g.ctxKey) return
  if (r.error) { $grill.set({ ...g2, loading: false, error: r.error }); return }
  $grill.set({ ...g2, loading: false, done: !!r.done, reason: r.reason || '', question: r.question || null,
    recommended: r.recommended || '', options: r.options || [], category: r.category || '' })
}

async function osGrillBrief() {
  const g = $grill.get()
  if (!g) return
  $grill.set({ ...g, loading: true })
  const r = await fetch(API + '/api/assist/brief', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: g.text, ladder: g.ladder }),
  }).then(r => r.json()).catch(() => null)
  const g2 = $grill.get()
  if (!g2) return
  if (r && r.ok) { g2.apply(r.brief); $grill.set(null); try { host.notify && host.notify('简报已填入输入框，由你确认后发送') } catch {} }
  else $grill.set({ ...g2, loading: false, error: (r && r.error) || '简报生成失败' })
}

function osGrillClose(restore) {
  const g = $grill.get()
  if (g && restore !== false) { try { g.apply(g.draft0) } catch {} }
  $grill.set(null)
}

function OsGrillPanel({ grill }) {
  const setAns = v => { const g = $grill.get(); if (g) $grill.set({ ...g, inputAnswer: v }) }
  return jsxs('div', { className: 'osg-grill', children: [
    jsxs('div', { className: 'osg-grill-head', children: [
      jsx('span', { className: 'osg-grill-title', children: ['🔥 拷问 · 把草稿烤成简报'] }),
      jsxs('button', { className: 'osg-grill-x', onClick: () => osGrillClose(true), children: ['Esc 恢复原稿'] }),
    ] }),
    grill.loading ? jsx('div', { className: 'osg-grill-loading', children: ['辅助模型思考中…'] }) : null,
    grill.error ? jsx('div', { className: 'osg-grill-err', children: [grill.error] }) : null,
    (grill.ladder || []).map((r, i) => jsxs('div', { className: 'osg-grill-rung', children: [
      jsxs('span', { className: 'osg-grill-q', children: ['Q' + (i + 1) + ' ' + r.question] }),
      jsxs('span', { className: 'osg-grill-a', children: ['→ ' + (r.answer || '（未答）')] }),
    ] }, i)),
    !grill.loading && grill.done ? jsxs('div', { className: 'osg-grill-done', children: [
      jsx('div', { children: ['草稿已足够明确：' + (grill.reason || '')] }),
      jsxs('button', { className: 'aod-btn aod-btn-pri', onClick: () => osGrillBrief(), children: ['生成简报'] }),
    ] }) : null,
    !grill.loading && !grill.done && grill.question ? jsxs('div', { className: 'osg-grill-live', children: [
      jsxs('div', { className: 'osg-grill-q', children: [grill.question] }),
      grill.recommended ? jsxs('button', { className: 'osg-grill-rec', onClick: () => osGrillSubmit(grill.recommended), children: ['推荐：' + grill.recommended + '（Tab）'] }) : null,
      jsxs('div', { className: 'osg-grill-opts', children:
        (grill.options || []).map((o, i) => jsxs('button', { key: i, className: 'osg-grill-opt', onClick: () => osGrillSubmit(o), children: [o] })) }),
      jsx('input', { className: 'osg-grill-ans', value: grill.inputAnswer,
        onChange: e => setAns(e.target.value),
        placeholder: '或自行输入答案（Enter 提交）',
        onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); osGrillSubmit(null) } },
        autoFocus: true }),
      jsxs('div', { className: 'aod-btnrow', style: { marginTop: 6 }, children: [
        jsxs('button', { className: 'aod-btn aod-btn-pri', onClick: () => osGrillSubmit(null), children: ['提交答案（Enter）'] }),
        (grill.ladder || []).length ? jsxs('button', { className: 'aod-btn', onClick: () => osGrillBrief(), children: ['生成简报'] }) : null,
      ] }),
    ] }) : null,
    jsx('div', { className: 'osg-grill-note', children: ['简报生成后填入输入框，由你亲自发送——绝不代发'] }),
  ] })
}

const $osActiveRoom = atom(null)   // 当前激活房间（全局 atom：来源去重跳转/外部深链要能定位到具体房间）
function OsGroupChat() {
  const rooms = useValue($osRooms) || []
  const activeId = useValue($osActiveRoom)
  const setActiveId = v => $osActiveRoom.set(v)
  const [showCreate, setShowCreate] = useState(false)
  const active = rooms.find(r => r.roomId === activeId) || null

  return jsxs('div', { className: 'osg-wrap', children: [
    jsxs('div', { className: 'osg-side', children: [
      jsxs('div', { className: 'osg-side-head', children: [
        jsx('span', { children: ['合议群'] }),
        jsxs('button', { className: 'aod-btn aod-btn-pri', onClick: () => setShowCreate(true), children: ['+ 发起合议'] }),
      ] }),
      jsxs('div', { className: 'osg-room-list', children: [
        rooms.length === 0 ? jsxs('div', { className: 'osg-empty', children: ['还没有合议群。点上方「+ 发起合议」创建。'] }) : null,
        ...rooms.map(r => jsxs('button', {
          className: 'osg-room-item' + (activeId === r.roomId ? ' on' : ''),
          onClick: () => setActiveId(r.roomId),
          children: [
            jsxs('div', { className: 'osg-room-name', children: [r.name] }),
            jsxs('div', { className: 'osg-room-meta', children: [
              r.members.length + ' 席 · ' + (r.log || []).length + ' 条 · ',
              r.engine && r.engine.running ? jsxs('span', { className: 'osg-live', children: ['● 第 ' + ((r.engine.round || 0) + 1) + ' 轮 '] }) : null,
              r.engine && r.engine.settled ? jsx('span', { className: 'osg-settled', children: ['已落定'] }) : null,
            ] }),
          ],
        }, r.roomId)),
      ] }),
    ] }),
    jsxs('div', { className: 'osg-main', children: [
      active ? jsx(OsRoomView, { room: active, onDeleted: () => setActiveId(null) }) : jsxs('div', { className: 'osg-empty', style: { paddingTop: 80 }, children: ['选择左侧合议群，或发起新合议。'] }),
    ] }),
    showCreate ? jsx(OsCreateRoomDialog, { onClose: () => setShowCreate(false), onCreated: (room) => { setShowCreate(false); setActiveId(room.roomId) } }) : null,
  ] })
}

function OsRoomView({ room, onDeleted }) {
  const [draft, setDraft] = useState('')
  const [dlg, setDlg] = useState(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [concluding, setConcluding] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const grill = useValue($grill)
  const grillActive = !!(grill && grill.ctxKey === 'room:' + room.roomId)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const log = room.log || []
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight }, [log.length])
  const eng = room.engine || {}

  const applyDraft = (v, caret) => {
    setDraft(v)
    requestAnimationFrame(() => { if (inputRef.current && caret != null) { inputRef.current.selectionStart = inputRef.current.selectionEnd = caret } })
  }

  const send = () => {
    const t = draft.trim()
    if (!t) return
    setDraft('')
    osAssistClose()
    osGrillClose(false)
    sendOsUserMessage(room.roomId, t)
  }
  const goFocus = () => { try { goFocusMatter(room.proposalId, room.roomId) } catch {} }
  const conclude = async () => {
    if (room.proposalId) {   // 幂等：已登记过 → 不再建提案，直达执行追踪
      goFocus()
      return
    }
    setConcluding(true)
    const r = await osRegisterConclusion(room.roomId)
    setConcluding(false)
    if (!r.ok) { try { host.notifyError && host.notifyError('登记失败：' + r.error) } catch {}; return }
    try { host.notify && host.notify(r.existed ? '已关联既有提案 ' + r.id : '已登记为提案 ' + r.id) } catch {}
  }

  return jsxs('div', { className: 'osg-room', children: [
    jsxs('div', { className: 'osg-room-head', children: [
      jsxs('div', { children: [
        jsxs('div', { className: 'osg-room-title', children: [room.name] }),
        jsxs('div', { className: 'osg-room-sub', children: [
          room.members.map(m => m.label).join(' · '),
          '　｜　轮次上限 ' + (room.maxRounds || OS_DEFAULT_ROUNDS),
          room.source && room.source.kind && room.source.kind !== 'manual' ? '　｜　来源：' + (room.source.kind === 'proposal' ? '提案 ' : room.source.kind === 'bootstrap' ? '自举议题 ' : '工单 ') + room.source.id : '',
        ] }),
      ] }),
      jsxs('div', { className: 'aod-btnrow', style: { marginTop: 0 }, children: [
        jsxs('button', { className: 'aod-btn' + ((room.mode || 'ASK') === 'EXEC' ? ' aod-btn-danger' : ' aod-btn-pri'),
          title: '点击切换：合议讨论（ASK，成员只表态不执行）/ 执行（EXEC，成员可执行议题相关操作）',
          onClick: () => patchRoom(room.roomId, r => { r.mode = (r.mode || 'ASK') === 'ASK' ? 'EXEC' : 'ASK'; return r }),
          children: [(room.mode || 'ASK') === 'EXEC' ? '⚡ 执行模式' : '💬 合议模式'] }),
        eng.running ? jsxs('button', { className: 'aod-btn aod-btn-danger', onClick: () => stopOsRounds(room.roomId), children: ['停止'] }) : null,
        eng.settled && !eng.running ? jsxs(Fragment, { children: [
          jsxs('button', { className: 'aod-btn', onClick: () => runOsRounds(room.roomId, { extraRounds: 3 }), children: ['+3 轮续场'] }),
          jsxs('button', { className: 'aod-btn' + (room.proposalId ? '' : ' aod-btn-pri'), disabled: concluding,
            title: room.proposalId ? '已登记（提案 ' + room.proposalId + '），点击打开执行追踪' : '把合议结论写入悬决台账（生成提案号，幂等不重复）',
            onClick: conclude,
            children: [concluding ? '登记中…' : room.proposalId ? '已登记 ' + room.proposalId + ' →' : '登记结论为提案'] }),
          jsx('button', { className: 'aod-btn', disabled: archiving, title: room.archivedId ? '已归档 ' + room.archivedId + '（幂等，不重复归档）' : '落台账 + 写 PC1 纪要文件 + 通知全部成员', onClick: async () => { setArchiving(true); const r = await archiveOsDeliberation(room.roomId); setArchiving(false); if (r && r.error) { try { host.notifyError && host.notifyError('归档失败：' + r.error) } catch {} } }, children: [archiving ? '归档中…' : room.archivedId ? '已归档 ' + room.archivedId : '归档纪要'] }),
        ] }) : null,
        jsxs('button', { className: 'aod-btn', title: '重命名群聊', onClick: () => setDlg('rename'), children: ['✏️'] }),
        jsxs('button', { className: 'aod-btn', title: '追加成员', onClick: () => setDlg('add'), children: ['➕'] }),
        confirmDel ? jsxs('button', { className: 'aod-btn aod-btn-danger', onClick: async () => { await deleteOsRoom(room.roomId); onDeleted && onDeleted() }, children: ['确认删除？'] })
          : jsxs('button', { className: 'aod-btn', title: '删除群聊', onClick: () => setConfirmDel(true), children: ['🗑'] }),
      ] }),
    ] }),
    dlg === 'rename' ? jsx(OsRenameDialog, { room, onClose: () => setDlg(null) }) : null,
    dlg === 'add' ? jsx(OsAddMembersDialog, { room, onClose: () => setDlg(null) }) : null,
    eng.running ? jsxs('div', { className: 'osg-progress', children: [
      '正在合议：第 ' + ((eng.round || 0) + 1) + ' 轮' + (eng.currentSeat ? ' · @' + eng.currentSeat + ' 发言中…' : '')
      + (eng.currentSeat && eng.progress && eng.progress[eng.currentSeat] ? '（已 ' + eng.progress[eng.currentSeat].chars + ' 字）' : ''),
    ] }) : null,
    eng.settled && !eng.running && room.proposalId ? jsxs('div', { className: 'osg-next', children: [
      jsxs('div', { className: 'osg-next-t', children: ['✅ 下一步：提案 ' + room.proposalId + (room.workOrderId ? ' ｜ 工单 ' + room.workOrderId : '')] }),
      jsxs('div', { className: 'osg-next-d', children: ['合议已落定、结论已入悬决台账。① 去悬决面板推进提案阶段；② 派单给 CEO——建一张「拆解执行」工单并送达 CEO 会话，由 CEO 拆解为席位工单下达（指挥链：执行经 CEO）。'] }),
      jsxs('div', { className: 'aod-btnrow', style: { marginTop: 0 }, children: [
        jsxs('button', { className: 'aod-btn', onClick: () => { try { $deckTab.set('pending'); $view.set('deck') } catch {} }, children: ['去悬决面板'] }),
        room.workOrderId
          ? jsxs('button', { className: 'aod-btn', onClick: () => { try { $deckTab.set('tasks'); $view.set('deck') } catch {} }, children: ['已派单 ' + room.workOrderId + ' →'] })
          : jsxs('button', { className: 'aod-btn aod-btn-pri', disabled: dispatching,
              onClick: async () => { setDispatching(true); const r = await osDispatchToCeo(room.roomId); setDispatching(false); if (!r.ok) { try { host.notifyError && host.notifyError('派单失败：' + r.error) } catch {} } },
              children: [dispatching ? '派单中…' : '派单给 CEO 执行'] }),
      ] }),
    ] }) : null,
    jsxs('div', { className: 'osg-log', ref: listRef, children: [
      log.length === 0 ? jsxs('div', { className: 'osg-empty', children: ['在下方输入议题，@席位可定向点名（如 @ceo @beta）。'] }) : null,
      ...log.map(m => {
        const isUser = m.from.kind === 'user'
        return jsxs('div', { className: 'osg-msg' + (isUser ? ' user' : '') + (m.sys ? ' sys' : ''), children: [
          jsxs('div', { className: 'osg-msg-head', children: [
            jsxs('span', { className: 'osg-msg-who', children: [isUser ? '峰哥' : (m.from.label || m.from.seat)] }),
            jsxs('span', { className: 'osg-msg-at', children: [new Date(m.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })] }),
          ] }),
          jsxs('div', { className: 'osg-msg-text', children: [m.text] }),
        ] }, m.id)
      }),
    ] }),
    jsxs('div', { className: 'osg-input', children: [
      grillActive && grill ? jsx(OsGrillPanel, { grill: grill }) : null,
      jsx('input', {
        ref: inputRef,
        value: draft, placeholder: grillActive ? '拷问进行中…（Enter 提交答案 / 生成简报 · Esc 恢复原稿）' : '输入议题…（@席位 点名 · / 命令 · Tab 拷问草稿）',
        disabled: grillActive,
        onChange: e => { setDraft(e.target.value); osAssistOnChange(e.target.value, e.target, applyDraft, room.members) },
        onKeyDown: e => {
          const a = $assist.get()
          if (a && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab' || e.key === 'Escape' || (e.key === 'Enter' && a.items && a.items.length))) { osAssistOnKey(e); return }
          const g = $grill.get()
          if (grillActive && g) {
            if (e.key === 'Escape') { e.preventDefault(); osGrillClose(true); return }
            if (e.key === 'Enter') { e.preventDefault(); (g.question && !g.done) ? osGrillSubmit(null) : osGrillBrief(); return }
            if (e.key === 'Tab') { e.preventDefault(); if (g.question) osGrillSubmit(g.recommended || g.inputAnswer); return }
            return
          }
          if (e.key === 'Tab' && draft.trim()) { e.preventDefault(); osGrillStart('room:' + room.roomId, draft, applyDraft); return }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
        },
        onBlur: () => setTimeout(osAssistClose, 150),
      }),
      jsxs('button', { className: 'aod-btn aod-btn-pri', onClick: send, children: ['发送'] }),
      jsx(OsAssistLayer, {}),
    ] }),
  ] })
}

function OsCreateRoomDialog({ onClose, onCreated }) {
  const rosterQuery = useRoster()
  const pc1 = useFetch(API + '/api/pc1/team')
  const [name, setName] = useState('')
  const [rounds, setRounds] = useState(OS_DEFAULT_ROUNDS)
  const [sel, setSel] = useState({})

  const profiles = (rosterQuery && rosterQuery.data && rosterQuery.data.profiles) || []
  const pc2Members = profiles.filter(p => p && p.name).map(p => ({ key: 'pc2:' + p.name, name: p.name, seat: p.name, label: p.title || p.name, machine: 'pc2' }))
  const pc1Members = ((pc1.data && pc1.data.profiles) || []).map(p => ({ key: 'pc1:' + p.name, seat: 'pc1/' + p.name, label: 'PC1·' + (p.alias || p.name), machine: 'pc1' }))
  const all = [...pc2Members, ...pc1Members]
  const chosen = all.filter(m => sel[m.key])

  const toggle = (k) => setSel(s => ({ ...s, [k]: !s[k] }))
  const selectDefault = () => { const o = {}; for (const m of pc2Members.slice(0, 8)) o[m.key] = true; setSel(o) }

  const create = () => {
    if (!chosen.length) return
    const room = createOsRoom({ name: name.trim(), members: chosen, maxRounds: rounds })
    onCreated(room)
  }

  return jsxs('div', { className: 'osg-mask', onClick: onClose, children: [
    jsxs('div', { className: 'osg-dialog', onClick: e => e.stopPropagation(), children: [
      jsxs('div', { className: 'osg-dialog-title', children: ['发起合议'] }),
      jsxs('label', { className: 'osg-field', children: [
        jsx('span', { children: ['合议主题'] }),
        jsx('input', { value: name, onChange: e => setName(e.target.value), placeholder: '如：GEO119 诊断方案评审' }),
      ] }),
      jsxs('label', { className: 'osg-field', children: [
        jsxs('span', { children: ['轮次上限（默认 6，最多 ', OS_MAX_ROUNDS_LIMIT, '）'] }),
        jsx('input', { type: 'number', min: 1, max: OS_MAX_ROUNDS_LIMIT, value: rounds, onChange: e => setRounds(Math.max(1, Math.min(parseInt(e.target.value || '6', 10) || 6, OS_MAX_ROUNDS_LIMIT))) }),
      ] }),
      jsxs('div', { className: 'osg-field', children: [
        jsxs('div', { className: 'osg-field-head', children: [
          jsxs('span', { children: ['选择成员（已选 ', chosen.length, ' / 上限 ', OS_MAX_MEMBERS, '）'] }),
          jsxs('button', { className: 'aod-btn', onClick: selectDefault, children: ['总经办 8 席'] }),
        ] }),
        jsxs('div', { className: 'osg-member-grid', children: all.map(m => jsxs('label', { className: 'osg-member' + (sel[m.key] ? ' on' : ''), children: [
          jsx('input', { type: 'checkbox', checked: !!sel[m.key], onChange: () => toggle(m.key) }),
          jsxs('span', { children: [m.label] }),
        ] }, m.key)) }),
      ] }),
      jsxs('div', { className: 'aod-btnrow', children: [
        jsxs('button', { className: 'aod-btn aod-btn-pri', onClick: create, disabled: !chosen.length, children: ['创建并开始'] }),
        jsxs('button', { className: 'aod-btn', onClick: onClose, children: ['取消'] }),
      ] }),
    ] }),
  ] })
}


// ══ AMM OPC OS 视图壳（办公室 / 指挥台 / 群聊）══
const $view = atom('office')
function OsShell() {
  const view = useValue($view)
  return jsxs('div', { className: 'amm-os-shell', children: [
    jsxs('div', { className: 'amm-os-viewbar', children: [
      jsxs('button', {
        className: 'amm-os-vtab' + (view === 'office' ? ' on' : ''),
        onClick: () => $view.set('office'),
        children: ['办公室'],
      }),
      jsxs('button', {
        className: 'amm-os-vtab' + (view === 'deck' ? ' on' : ''),
        onClick: () => $view.set('deck'),
        children: ['指挥台'],
      }),
      jsxs('button', {
        className: 'amm-os-vtab' + (view === 'chat' ? ' on' : ''),
        onClick: () => $view.set('chat'),
        children: ['群聊'],
      }),
    ] }),
    jsxs('div', { className: 'amm-os-view', children: [
      view === 'deck' ? jsx(DeskHome, {})
        : view === 'chat' ? jsx(OsGroupChat, {})
        : jsxs(Fragment, { children: [jsx(Pc1TeamBar, {}), jsx(OfficeFloor, {})] }),
    ] }),
  ] })
}

// OsShell 视图条样式（并入 desk css 注入器之外的独立小样式，避免与 office 场景样式纠缠）
const OS_SHELL_CSS = `
.amm-os-shell{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;height:100%;width:100%}
.amm-os-viewbar{flex:none;display:flex;gap:4px;padding:8px 12px;background:color-mix(in srgb, Canvas 92%, transparent);border-bottom:1px solid color-mix(in srgb, CanvasText 18%, transparent)}
.amm-os-vtab{padding:5px 16px;border-radius:6px;border:1px solid transparent;background:none;color:CanvasText;font:inherit;font-size:13px;cursor:pointer;opacity:.7}
.amm-os-vtab:hover{opacity:1}
.amm-os-vtab.on{opacity:1;border-color:color-mix(in srgb, CanvasText 30%, transparent);background:color-mix(in srgb, CanvasText 10%, transparent);font-weight:600}
.amm-os-view{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
.amm-os-chatph{padding:60px 30px;text-align:center;opacity:.75}
.amm-os-chatph-t{font-size:18px;font-weight:700;margin-bottom:10px}
.amm-os-chatph-d{font-size:13px;line-height:1.7}

/* ── 群聊（合议）样式 ── */
.osg-wrap{display:flex;gap:0;height:calc(100vh - 120px);min-height:420px;border:1px solid rgba(128,128,128,.25);border-radius:8px;overflow:hidden}
.osg-side{width:240px;flex:none;border-right:1px solid rgba(128,128,128,.25);display:flex;flex-direction:column;background:rgba(127,127,127,.04)}
.osg-side-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(128,128,128,.2);font-weight:600}
.osg-room-list{flex:1;overflow-y:auto}
.osg-room-item{display:block;width:100%;text-align:left;padding:10px 12px;border:none;border-bottom:1px solid rgba(128,128,128,.12);background:none;color:inherit;cursor:pointer}
.osg-room-item.on{background:rgba(88,166,255,.12)}
.osg-room-name{font-weight:600;font-size:13px}
.osg-room-meta{font-size:11px;opacity:.65;margin-top:2px}
.osg-live{color:#3fb950}
.osg-settled{opacity:.7}
.osg-main{flex:1;display:flex;flex-direction:column;min-width:0}
.osg-empty{padding:30px;text-align:center;opacity:.55;font-size:13px}
.osg-room{display:flex;flex-direction:column;height:100%}
.osg-room-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(128,128,128,.2)}
.osg-room-title{font-weight:700;font-size:14px}
.osg-room-sub{font-size:11.5px;opacity:.6;margin-top:2px}
.osg-progress{padding:6px 14px;font-size:12px;color:#58a6ff;border-bottom:1px solid rgba(128,128,128,.15);background:rgba(88,166,255,.06)}
.osg-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.osg-msg{max-width:78%;align-self:flex-start}
.osg-msg.user{align-self:flex-end}
.osg-msg.sys{opacity:.6}
.osg-msg-head{display:flex;gap:8px;align-items:baseline;margin-bottom:2px}
.osg-msg-who{font-size:11.5px;font-weight:600;opacity:.8}
.osg-msg-at{font-size:10px;opacity:.5}
.osg-msg-text{padding:8px 12px;border-radius:10px;background:rgba(127,127,127,.12);font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.osg-msg.user .osg-msg-text{background:#2f6feb;color:#fff}
.osg-input{display:flex;gap:8px;padding:12px 14px;border-top:1px solid rgba(128,128,128,.2)}
.osg-input input{flex:1;padding:8px 12px;border:1px solid rgba(128,128,128,.4);border-radius:8px;background:rgba(127,127,127,.08);color:inherit;font-size:13px}
.osg-mask{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:950;display:flex;align-items:center;justify-content:center}
.osg-dialog{width:520px;max-width:94vw;max-height:88vh;overflow-y:auto;background:#1e1e22;border:1px solid rgba(128,128,128,.35);border-radius:10px;padding:18px;color:#e6e6e6}
.osg-dialog-title{font-weight:700;font-size:15px;margin-bottom:14px}
.osg-field{display:block;margin-bottom:14px}
.osg-field>span{display:block;font-size:11.5px;opacity:.65;margin-bottom:4px}
.osg-field input{width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:rgba(127,127,127,.08);color:inherit;font-size:13px}
.osg-field-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.osg-member-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px;max-height:260px;overflow-y:auto;padding:4px;border:1px solid rgba(128,128,128,.2);border-radius:8px}
.osg-member{display:flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid rgba(128,128,128,.2);border-radius:6px;font-size:12px;cursor:pointer}
.osg-member.on{border-color:#2f6feb;background:rgba(47,111,235,.12)}
/* ── PC1 远程团队横条 ── */
.pc1-team-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid rgba(128,128,128,.2);background:rgba(127,127,127,.05);font-size:11.5px}
.pc1-team-label{font-weight:600;opacity:.75;margin-right:4px}
.pc1-team-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border:1px solid rgba(128,128,128,.25);border-radius:10px;opacity:.85}
.pc1-dot{width:7px;height:7px;border-radius:50%;background:rgba(128,128,128,.5);display:inline-block}
.pc1-dot.on{background:#3fb950}
.pc1-team-down{color:#d29922}
.pc1-team-dim{opacity:.55}
.pc1-team-note{margin-left:auto;opacity:.45;font-size:10.5px}
/* ── Grill 拷问面板 ── */
.osg-grill{position:fixed;left:50%;transform:translateX(-50%);bottom:120px;width:520px;max-width:92vw;max-height:60vh;overflow-y:auto;background:#1e1e22;color:#e6e6e6;border:1px solid rgba(88,166,255,.45);border-radius:10px;box-shadow:0 12px 36px rgba(0,0,0,.5);z-index:9700;padding:14px 16px}
.osg-grill-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.osg-grill-title{font-weight:700;font-size:13.5px}
.osg-grill-x{background:none;border:0;color:inherit;opacity:.6;cursor:pointer;font-size:11.5px}
.osg-grill-x:hover{opacity:1}
.osg-grill-loading{font-size:12px;opacity:.7;padding:6px 0}
.osg-grill-err{color:#f85149;font-size:12px;padding:6px 0}
.osg-grill-rung{padding:5px 0;border-bottom:1px dashed rgba(128,128,128,.2);font-size:12px}
.osg-grill-q{font-weight:600;font-size:12.5px;margin-bottom:2px}
.osg-grill-a{opacity:.75;font-size:12px}
.osg-grill-done{padding:8px 0;font-size:12.5px}
.osg-grill-live{padding:4px 0}
.osg-grill-rec{display:block;width:100%;text-align:left;margin:6px 0;padding:7px 10px;border-radius:6px;border:1px solid rgba(88,166,255,.5);background:rgba(88,166,255,.1);color:inherit;font-size:12.5px;cursor:pointer}
.osg-grill-opts{display:flex;flex-direction:column;gap:4px;margin:6px 0}
.osg-grill-opt{text-align:left;padding:6px 10px;border-radius:6px;border:1px solid rgba(128,128,128,.3);background:rgba(127,127,127,.08);color:inherit;font-size:12.5px;cursor:pointer}
.osg-grill-opt:hover{background:rgba(127,127,127,.2)}
.osg-grill-ans{width:100%;box-sizing:border-box;margin-top:6px;padding:7px 10px;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:rgba(127,127,127,.08);color:inherit;font-size:12.5px}
.amm-os-chatph-d{font-size:13px;line-height:1.7}
.office-task-attach{border:0;background:transparent;color:var(--ui-text-secondary,inherit);font-size:16px;cursor:pointer;padding:0 4px;line-height:1}
.office-task-attach:hover{transform:scale(1.15)}
.osg-assist{background:#1e1e22;color:#e6e6e6;border:1px solid rgba(128,128,128,.4);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.4);overflow:hidden;min-width:340px}
.osg-assist-item{display:flex;gap:10px;align-items:baseline;width:100%;text-align:left;padding:7px 12px;border:0;background:none;color:inherit;font:inherit;font-size:12.5px;cursor:pointer}
.osg-assist-item.on{background:rgba(88,166,255,.18)}
.osg-assist-main{font-weight:600;white-space:nowrap}
.osg-assist-desc{opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.osg-next{margin:8px 14px;padding:10px 14px;border:1px solid rgba(63,185,80,.45);border-radius:8px;background:rgba(63,185,80,.07)}
.osg-next-t{font-weight:700;font-size:12.5px;margin-bottom:4px}
.osg-next-d{font-size:12px;opacity:.75;margin-bottom:8px;line-height:1.6}
`
function injectOsShellCss() {
  let el = document.getElementById('amm-os-shell-css')
  if (!el) { el = document.createElement('style'); el.id = 'amm-os-shell-css'; document.head.appendChild(el) }
  el.textContent = OS_SHELL_CSS
}

// ══ 指挥台面板（原 amm-opc-desk 搬入）══
// el()：统一 JSX 入口 —— 把 props 里的 key 抽出来按 jsx-runtime 规范传第三参
// （React 19 起 key 放 props 会告警且失效；第三参就是 key 槽位，children 永远在 props 里）
// 另：数组 children 若缺 key，自动按 index 补（静态字面量数组无语义 key，仅消警告）
function el(type, props) {
  if (!props) return jsx(type, props)
  let { key, children, ...rest } = props
  if (Array.isArray(children)) {
    children = children.map((c, i) =>
      c && typeof c === 'object' && c.key == null ? { ...c, key: '@k' + i } : c)
  }
  const p = children === undefined ? rest : { ...rest, children }
  return key !== undefined ? jsx(type, p, key) : jsx(type, p)
}

const API = 'http://127.0.0.1:8901'

const SEATS = ['ceo', 'research-lead', 'strategy-director', 'quality-auditor',
  'skills-architect', 'workflow-designer', 'controller', 'independent-reviewer']

// 决策事项八步议事的阶段链（已裁定/已废止 = 闭环态，不再出现在悬决清单）
const PROPOSAL_STAGES = ['提案中', '事实收集中', '方案比选中', '合议中', '已裁定']

const EXPENSE_CATEGORIES = ['人力', '场地', '折旧', '运营', '采购', '其他']

const TABS = [
  { id: 'focus', label: '执行追踪' },
  { id: 'pending', label: '悬决' },
  { id: 'tasks', label: '任务' },
  { id: 'acceptance', label: '验收' },
  { id: 'ledger', label: '账本' },
  { id: 'finance', label: '经营' },
  { id: 'ops', label: '运营' },
  { id: 'search', label: '检索' },
]

// ══════════════════════════════════════════════════════════
// 样式（注入 <style>，半透明 + currentColor，深浅色界面均可用）
// ══════════════════════════════════════════════════════════
const CSS = `
.aod-page{padding:18px 22px 48px;max-width:1080px;font-size:13px;color:inherit}
.aod-tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:16px;border-bottom:1px solid rgba(128,128,128,.25)}
.aod-tab{padding:7px 14px;cursor:pointer;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;opacity:.7;background:none;color:inherit;font-size:13px}
.aod-tab:hover{opacity:1}
.aod-tab.on{opacity:1;border-color:rgba(128,128,128,.3);background:rgba(127,127,127,.12);font-weight:600}
.aod-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:2px 0 14px;flex-wrap:wrap}
.aod-h1{font-size:17px;font-weight:700;margin:0}
.aod-sub{font-size:12px;opacity:.65;margin-top:3px}
.aod-stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.aod-stat{flex:1;min-width:130px;border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:10px 12px}
.aod-stat b{display:block;font-size:20px;margin-top:2px}
.aod-stat span{font-size:11px;opacity:.65}
.aod-card{border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:12px 14px;margin-bottom:14px}
.aod-card h3{margin:0 0 8px;font-size:13px;font-weight:600}
.aod-tblwrap{overflow-x:auto}
.aod-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.aod-tbl th{text-align:left;padding:6px 8px;opacity:.6;font-weight:500;border-bottom:1px solid rgba(128,128,128,.3);white-space:nowrap}
.aod-tbl td{padding:7px 8px;border-bottom:1px solid rgba(128,128,128,.15)}
.aod-row{cursor:pointer}
.aod-row:hover td{background:rgba(127,127,127,.1)}
.aod-tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;border:1px solid;white-space:nowrap}
.aod-t-ok{color:#3fb950;border-color:rgba(63,185,80,.4);background:rgba(63,185,80,.08)}
.aod-t-warn{color:#d29922;border-color:rgba(210,153,34,.4);background:rgba(210,153,34,.08)}
.aod-t-err{color:#f85149;border-color:rgba(248,81,73,.4);background:rgba(248,81,73,.08)}
.aod-t-info{color:#58a6ff;border-color:rgba(88,166,255,.4);background:rgba(88,166,255,.08)}
.aod-t-mute{opacity:.7;border-color:rgba(128,128,128,.4)}
.aod-btn{padding:5px 12px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:rgba(127,127,127,.12);color:inherit;cursor:pointer;font-size:12.5px}
.aod-btn:hover:not(:disabled){background:rgba(127,127,127,.24)}
.aod-btn:disabled{opacity:.5;cursor:wait}
.aod-btn-pri{background:#2f6feb;border-color:#2f6feb;color:#fff}
.aod-btn-pri:hover:not(:disabled){background:#4480f6}
.aod-btn-danger{border-color:rgba(248,81,73,.5);color:#f85149}
.aod-btnrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.aod-drawer-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:900}
.aod-drawer{position:fixed;top:0;right:0;bottom:0;width:430px;max-width:92vw;background:#1e1e22;border-left:1px solid rgba(128,128,128,.35);z-index:901;overflow-y:auto;box-shadow:-8px 0 24px rgba(0,0,0,.35);color:#e6e6e6}
.aod-drawer-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid rgba(128,128,128,.25);position:sticky;top:0;background:#1e1e22;z-index:1}
.aod-drawer-title{font-weight:700;font-size:14px}
.aod-drawer-close{background:none;border:none;color:inherit;font-size:16px;cursor:pointer;opacity:.7}
.aod-drawer-body{padding:14px 16px 30px}
.aod-kv{display:flex;gap:10px;padding:6px 0;border-bottom:1px dashed rgba(128,128,128,.15);font-size:12.5px}
.aod-kv-k{width:92px;flex:none;opacity:.6}
.aod-kv-v{flex:1;word-break:break-all;white-space:pre-wrap}
.aod-steps{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
.aod-step{flex:1;min-width:140px;border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:8px 10px}
.aod-step.done{border-color:rgba(63,185,80,.5);background:rgba(63,185,80,.08)}
.aod-step.doing{border-color:rgba(210,153,34,.65);background:rgba(210,153,34,.1)}
.aod-step.pending{opacity:.55}
.aod-step-t{font-weight:700;font-size:12.5px;margin-bottom:2px}
.aod-step-n{font-size:11.5px;opacity:.78;line-height:1.5}
.aod-form{margin-top:14px;border-top:1px solid rgba(128,128,128,.25);padding-top:12px}
.aod-form-title{font-weight:600;margin-bottom:10px;font-size:13px}
.aod-field{display:block;margin-bottom:10px}
.aod-field-label{display:block;font-size:11.5px;opacity:.65;margin-bottom:3px}
.aod-field input,.aod-field select{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:rgba(127,127,127,.08);color:inherit;font-size:12.5px}
.aod-msg{margin-top:10px;padding:8px 10px;border-radius:6px;font-size:12.5px}
.aod-m-ok{background:rgba(63,185,80,.12);color:#3fb950}
.aod-m-err{background:rgba(248,81,73,.12);color:#f85149}
.aod-note{font-size:11.5px;opacity:.6;margin-top:8px;line-height:1.6}
.aod-load,.aod-empty{padding:26px 0;text-align:center;opacity:.6;font-size:13px}
.aod-err{padding:14px;border:1px solid rgba(248,81,73,.4);border-radius:8px;margin:10px 0}
.aod-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.aod-search{width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid rgba(128,128,128,.4);border-radius:8px;background:rgba(127,127,127,.08);color:inherit;font-size:13px;margin-bottom:12px}
`

function injectDeskCss() {
  let el = document.getElementById('amm-opc-desk-css')
  if (!el) {
    el = document.createElement('style')
    el.id = 'amm-opc-desk-css'
    document.head.appendChild(el)
  }
  el.textContent = CSS
}

// ══════════════════════════════════════════════════════════
// Hooks
// ══════════════════════════════════════════════════════════
function useFetch(url, intervalMs) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    fetch(url)
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then(d => { if (alive) { setData(d); setLoading(false); setError(null) } })
      .catch(e => { if (alive) { setLoading(false); setError(String(e && e.message || e)) } })
    return () => { alive = false }
  }, [url, tick])
  useEffect(() => {
    if (!intervalMs) return undefined
    const t = setInterval(() => setTick(x => x + 1), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return { data, loading, error, refresh: () => setTick(t => t + 1) }
}

function useAction() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const run = (endpoint, body, onDone) => {
    setBusy(true)
    setMsg(null)
    fetch(API + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(d => {
        setBusy(false)
        setMsg({ ok: !!d.ok, text: d.message || d.error || '完成' })
        if (d.ok && onDone) onDone()
      })
      .catch(e => { setBusy(false); setMsg({ ok: false, text: String(e && e.message || e) }) })
  }
  return { busy, msg, run }
}

// ══════════════════════════════════════════════════════════
// 基础组件
// ══════════════════════════════════════════════════════════
function Btn({ children, onClick, kind, disabled }) {
  const cls = 'aod-btn' + (kind === 'pri' ? ' aod-btn-pri' : kind === 'danger' ? ' aod-btn-danger' : '')
  return el('button', { className: cls, onClick, disabled: !!disabled, children })
}

function Tag({ tone, children }) {
  return el('span', { className: 'aod-tag aod-t-' + (tone || 'mute'), children })
}

function Stat({ label, value, tone }) {
  return el('div', { className: 'aod-stat', children: [
    el('span', { children: [label] }),
    el('b', { style: tone === 'err' ? { color: '#f85149' } : tone === 'ok' ? { color: '#3fb950' } : null, children: [String(value)] }),
  ] })
}

function Card({ title, children }) {
  return el('div', { className: 'aod-card', children: [
    title ? el('h3', { key: 'title', children: [title] }) : null,
    ...Array.isArray(children) ? children : [children],
  ] })
}

function Load() { return el('div', { className: 'aod-load', children: ['加载中…'] }) }

function Empty({ children }) { return el('div', { className: 'aod-empty', children: children || ['暂无数据'] }) }

function ErrBox({ children, onRetry }) {
  return el('div', { className: 'aod-err', children: [
    el('div', { children: ['⚠ 快照服务不可达：', children] }),
    el('div', { className: 'aod-note', children: ['请确认 D:\\hermes\\scripts\\ledger_snapshot_server.py 正在运行（127.0.0.1:8901）'] }),
    onRetry ? el('div', { className: 'aod-btnrow', children: [
      el(Btn, { onClick: onRetry, children: ['重试'] }),
    ] }) : null,
  ] })
}

function Msg({ msg }) {
  if (!msg) return null
  return el('div', { className: 'aod-msg ' + (msg.ok ? 'aod-m-ok' : 'aod-m-err'), children: [msg.text] })
}

function M2Placeholder({ title, desc, items }) {
  return el(Card, { title: title, children: [
    el('div', { children: [desc] }),
    items && items.length ? el('div', { className: 'aod-btnrow', children: items.map((it, i) =>
      el(Tag, { key: i, tone: 'mute', children: [it] })) }) : null,
  ] })
}

// 表格：cols=表头数组，items=[{key, cells:[...], onClick}]
function Tbl({ cols, items, empty }) {
  if (!items || !items.length) return el(Empty, { children: [empty || '暂无数据'] })
  return el('div', { className: 'aod-tblwrap', children: [
    el('table', { className: 'aod-tbl', children: [
      el('thead', { children: [
        el('tr', { children: cols.map((c, j) => el('th', { key: j, children: [c] })) }),
      ] }),
      el('tbody', { children: items.map(it =>
        el('tr', { key: it.key, className: 'aod-row', onClick: it.onClick, children:
          it.cells.map((c, j) => el('td', { key: j, children: [c] })) })) }),
    ] }),
  ] })
}

// 通用表单：fields=[{key,label,type,options,default,placeholder}]
function ActionForm({ title, fields, submitLabel, onSubmit, busy }) {
  const init = () => {
    const v = {}
    for (const f of fields) v[f.key] = f.default != null ? f.default : ''
    return v
  }
  const [vals, setVals] = useState(init)
  const set = (k, val) => setVals(prev => ({ ...prev, [k]: val }))
  return el('form', { className: 'aod-form', onSubmit: e => { e.preventDefault(); onSubmit(vals) }, children: [
    title ? el('div', { key: 'title', className: 'aod-form-title', children: [title] }) : null,
    ...fields.map(f => el('label', { key: f.key, className: 'aod-field', children: [
      el('span', { className: 'aod-field-label', children: [f.label] }),
      f.type === 'select'
        ? el('select', { value: vals[f.key], onChange: e => set(f.key, e.target.value), children:
            f.options.map(o => el('option', { key: o, value: o, children: [o] })) })
        : el('input', {
            type: f.type || 'text',
            value: vals[f.key],
            onChange: e => set(f.key, e.target.value),
            placeholder: f.placeholder || '',
          }),
    ] })),
    el(Btn, { key: 'submit', kind: 'pri', disabled: busy, onClick: null, children: [submitLabel] }),
  ] })
}

// 详情抽屉：fields=[[标签,值]]，children=操作区（按钮/表单）
function Drawer({ title, subtitle, fields, onClose, children }) {
  return el(Fragment, { children: [
    el('div', { className: 'aod-drawer-mask', onClick: onClose }),
    el('div', { className: 'aod-drawer', children: [
      el('div', { className: 'aod-drawer-head', children: [
        el('div', { children: [
          el('div', { className: 'aod-drawer-title', children: [title] }),
          subtitle ? el('div', { className: 'aod-sub', children: [subtitle] }) : null,
        ] }),
        el('button', { className: 'aod-drawer-close', onClick: onClose, children: ['✕'] }),
      ] }),
      el('div', { className: 'aod-drawer-body', children: [
        ...fields.map(([k, v], i) => el('div', { key: i, className: 'aod-kv', children: [
          el('span', { className: 'aod-kv-k', children: [k] }),
          el('span', { className: 'aod-kv-v', children: [v == null || v === '' ? '—' : String(v)] }),
        ] })),
        children,
      ] }),
    ] }),
  ] })
}

// ══════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════
const fmtDT = s => s ? String(s).replace('T', ' ').slice(0, 16) : '—'
const fmtD = s => s ? String(s).slice(0, 10) : '—'
const fen = c => c == null ? '—' : '¥' + (Number(c) / 100).toFixed(2)
const today = () => new Date().toISOString().slice(0, 10)
const priorityTone = p => p === 'P1' ? 'err' : p === 'P2' ? 'warn' : 'info'
const stageTone = s => s === '已裁定' ? 'ok' : s === '已废止' ? 'mute' : 'info'
const yuanToCents = v => {
  const n = parseFloat(v)
  if (!isFinite(n) || n <= 0) return null
  return Math.round(n * 100)
}

// ══════════════════════════════════════════════════════════
// 面板 1：悬决清单
// ══════════════════════════════════════════════════════════
// 最近登记区块（含已裁定）：登记完的提案不再从「待决提案」视图里消失（09-20 峰哥反馈断链修复）
function RecentProposalsCard({ onOpen }) {
  const allP = useFetch(API + '/api/ledger/proposals')
  const recent = (Array.isArray(allP.data) ? allP.data : []).slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 5)
  return el(Card, { title: '最近登记（含已裁定 · 点击开详情；全链路看「执行追踪」）', children: [
    el(Tbl, {
      cols: ['提案号', '标题', '阶段', '登记时间'],
      empty: allP.loading ? '加载中…' : '暂无提案',
      items: recent.map(p => ({
        key: p.proposalId,
        onClick: () => onOpen(p),
        cells: [
          p.proposalId,
          p.title,
          el(Tag, { tone: stageTone(p.currentStage), children: [p.currentStage] }),
          fmtDT(p.createdAt),
        ],
      })),
    }),
  ] })
}

function PendingPanel() {
  const { data, loading, error, refresh } = useFetch(API + '/api/ledger/pending')
  const { busy, msg, run } = useAction()
  const [sel, setSel] = useState(null) // {kind, item}
  const [showNew, setShowNew] = useState(false)
  const onDone = () => { setSel(null); refresh() }

  if (loading) return el(Load, {})
  if (error) return el(ErrBox, { children: [error], onRetry: refresh })

  const s = data.summary || {}
  const proposals = data.proposals || []
  const escalations = data.escalations || []
  const commitments = data.commitments || []

  return el('div', { children: [
    el('div', { className: 'aod-head', children: [
      el('div', { children: [
        el('h1', { className: 'aod-h1', children: ['悬决清单'] }),
        el('div', { className: 'aod-sub', children: ['待峰哥处理的事项 · 数据源 PROPOSALS / ESCALATIONS / COMMITMENTS'] }),
      ] }),
      el(Btn, { kind: 'pri', onClick: () => setShowNew(v => !v), children: [showNew ? '收起' : '+ 发起提案'] }),
    ] }),

    el('div', { className: 'aod-stats', children: [
      el(Stat, { label: '悬决总数', value: s.pendingCount || 0 }),
      el(Stat, { label: '待决提案', value: s.pendingProposals || 0 }),
      el(Stat, { label: '待决升级单', value: s.pendingEscalations || 0 }),
      el(Stat, { label: '未销号承诺', value: s.openCommitments || 0, tone: 'err' }),
    ] }),

    el(RecentProposalsCard, { onOpen: p => setSel({ kind: 'proposal', item: p }) }),

    showNew ? el(Card, { title: '发起提案（八步议事 · 提案中）', children: [
      el(ActionForm, {
        title: '',
        fields: [
          { key: 'title', label: '提案标题', placeholder: '一句话说清议题' },
          { key: 'targetAnchor', label: '目标锚（OBJECTIVE 指针）', placeholder: '如 OBJECTIVE §二 读数③' },
          { key: 'proposerSeat', label: '提案席位', type: 'select', options: SEATS, default: 'ceo' },
          { key: 'priority', label: '优先级', type: 'select', options: ['P1', 'P2', 'P3'], default: 'P2' },
          { key: 'deadline', label: '截止日', type: 'date' },
        ],
        submitLabel: '提交提案',
        busy,
        onSubmit: v => {
          if (!v.title || !v.targetAnchor) { return }
          run('/api/action/proposal', v, () => { setShowNew(false); refresh() })
        },
      }),
      el(Msg, { msg: msg }),
    ] }) : null,

    el(Card, { title: '待决提案（点击行 → 推进阶段）', children: [
      el(Tbl, {
        cols: ['提案号', '标题', '提案席位', '优先级', '当前阶段', '截止日'],
        empty: '无待决提案',
        items: proposals.map(p => ({
          key: p.proposalId,
          onClick: () => setSel({ kind: 'proposal', item: p }),
          cells: [
            p.proposalId,
            p.title,
            p.proposerSeat,
            el(Tag, { tone: priorityTone(p.priority), children: [p.priority || '—'] }),
            el(Tag, { tone: stageTone(p.currentStage), children: [p.currentStage] }),
            fmtD(p.deadline),
          ],
        })),
      }),
    ] }),

    el(Card, { title: '待决升级单（点击行 → 回复处置）', children: [
      el(Tbl, {
        cols: ['升级单号', '决策号', '发起席位', '触发条件', '最保守默认项', '状态'],
        empty: '无待决升级单',
        items: escalations.map(e => ({
          key: e.escalationId,
          onClick: () => setSel({ kind: 'escalation', item: e }),
          cells: [
            e.escalationId,
            e.decisionId,
            e.fromSeat,
            e.trigger,
            e.conservativeDefault,
            el(Tag, { tone: 'warn', children: [e.status || '待决'] }),
          ],
        })),
      }),
    ] }),

    el(Card, { title: '未销号承诺（点击行 → 销号）', children: [
      el(Tbl, {
        cols: ['#', '事项', '负责人', '截止日', '类型'],
        empty: '无未销号承诺',
        items: commitments.map(c => ({
          key: c['序号'],
          onClick: () => setSel({ kind: 'commitment', item: c }),
          cells: [
            '#' + c['序号'],
            c['事项'],
            c['负责人'],
            el(Tag, { tone: c['截止日'] && c['截止日'] < today() ? 'err' : 'mute', children: [fmtD(c['截止日'])] }),
            c['类型'] || '—',
          ],
        })),
      }),
    ] }),

    sel && sel.kind === 'proposal' ? el(ProposalDrawer, { p: sel.item, busy, msg, run, onDone, onClose: () => setSel(null) }) : null,
    sel && sel.kind === 'escalation' ? el(EscalationDrawer, { e: sel.item, busy, msg, run, onDone, onClose: () => setSel(null) }) : null,
    sel && sel.kind === 'commitment' ? el(CommitmentDrawer, { c: sel.item, busy, msg, run, onDone, onClose: () => setSel(null) }) : null,
  ] })
}

function ProposalDrawer({ p, busy, msg, run, onDone, onClose }) {
  const idx = PROPOSAL_STAGES.indexOf(p.currentStage)
  const next = idx >= 0 && idx < PROPOSAL_STAGES.length - 1 ? PROPOSAL_STAGES[idx + 1] : null
  const [confirmCollab, setConfirmCollab] = useState(false)
  return el(Drawer, {
    title: p.title,
    subtitle: p.proposalId + ' · ' + (p.currentStage || ''),
    onClose,
    fields: [
      ['提案号', p.proposalId],
      ['目标锚', p.targetAnchor],
      ['提案席位', p.proposerSeat],
      ['优先级', p.priority],
      ['当前阶段', p.currentStage],
      ['截止日', fmtD(p.deadline)],
      ['创建于', fmtDT(p.createdAt)],
      ['更新于', fmtDT(p.updatedAt)],
      ...(p.fiveItems ? [['合议结论摘要', p.fiveItems]] : []),
    ],
    children: el(Fragment, { children: [
      next ? el('div', { className: 'aod-btnrow', children: [
        el(Btn, { kind: 'pri', disabled: busy, onClick: () => run('/api/action/update-stage', { proposalId: p.proposalId, newStage: next }, onDone), children: ['推进至「' + next + '」'] }),
      ] }) : null,
      p.currentStage !== '已裁定' && p.currentStage !== '已废止' ? el('div', { className: 'aod-btnrow', children: [
        el(Btn, { kind: 'danger', disabled: busy, onClick: () => run('/api/action/update-stage', { proposalId: p.proposalId, newStage: '已废止' }, onDone), children: ['废止提案'] }),
      ] }) : null,
      el('div', { className: 'aod-btnrow', children: [
        confirmCollab
          ? el(Btn, { kind: 'pri', onClick: () => { setConfirmCollab(false); try { osStartRoomFromProposal(p); onClose() } catch (err) { try { host.notifyError && host.notifyError('合议启动失败：' + (err && err.message || err)) } catch {} } }, children: ['确认发起？将创建 8 席合议群并自动开始（已有合议群则跳转不重建）'] })
          : el(Btn, { title: '从本提案创建 8 席合议群并自动开始合议（同一提案不重复建群）', onClick: () => setConfirmCollab(true), children: ['发起合议（8 席）'] }),
      ] }),
      el(Msg, { msg: msg }),
    ] }),
  })
}

function EscalationDrawer({ e, busy, msg, run, onDone, onClose }) {
  return el(Drawer, {
    title: '升级单 ' + e.escalationId,
    subtitle: e.decisionId + ' · ' + (e.status || ''),
    onClose,
    fields: [
      ['决策号', e.decisionId],
      ['发起席位', e.fromSeat],
      ['触发条件', e.trigger],
      ['最保守默认项', e.conservativeDefault],
      ['状态', e.status],
      ['提交于', fmtDT(e.submittedAt)],
    ],
    children: el(Fragment, { children: [
      el('div', { className: 'aod-btnrow', children: [
        el(Btn, { kind: 'pri', disabled: busy, onClick: () => run('/api/action/escalation-reply', { escalationId: e.escalationId, status: '已执行', resolution: '峰哥确认执行' }, onDone), children: ['标记已执行'] }),
        el(Btn, { kind: 'danger', disabled: busy, onClick: () => run('/api/action/escalation-reply', { escalationId: e.escalationId, status: '已否决', resolution: '峰哥否决' }, onDone), children: ['否决'] }),
      ] }),
      el(Msg, { msg: msg }),
    ] }),
  })
}

function CommitmentDrawer({ c, busy, msg, run, onDone, onClose }) {
  return el(Drawer, {
    title: '#' + c['序号'] + ' ' + c['事项'],
    subtitle: '负责人 ' + c['负责人'] + ' · 截止 ' + fmtD(c['截止日']),
    onClose,
    fields: [
      ['事项', c['事项']],
      ['负责人', c['负责人']],
      ['截止日', fmtD(c['截止日'])],
      ['类型', c['类型']],
      ['建议动作', c['建议动作(三选一)']],
      ['理由', c['理由']],
      ['出处文件', c['出处文件']],
      ['首次出现', fmtD(c['首次出现'])],
      ['归宿', c['归宿'] || '（未销号）'],
    ],
    children: el(Fragment, { children: [
      el(ActionForm, {
        title: '销号（R-21：开发类承诺必须 A 级证据）',
        fields: [
          { key: 'evidenceGrade', label: '证据分级', type: 'select', options: ['A', 'B', 'C'], default: 'A' },
          { key: 'evidenceNote', label: '证据说明', placeholder: '如：截图 / 测试报告 / 可访问链接' },
        ],
        submitLabel: '确认销号',
        busy,
        onSubmit: v => run('/api/action/close-commitment', {
          commitmentId: String(c['序号']),
          evidenceGrade: v.evidenceGrade,
          evidenceNote: v.evidenceNote || '已核验',
          taskCategory: c['类型'] || '',
        }, onDone),
      }),
      el(Msg, { msg: msg }),
    ] }),
  })
}

// ══════════════════════════════════════════════════════════
// 面板 2：任务看板（Q45 修订：接 paperclip issues 真数据 + 本地工单）
// ══════════════════════════════════════════════════════════
const KANBAN_BUCKETS = [
  { id: 'PENDING', label: '待受理', tone: 'mute' },
  { id: 'EXECUTING', label: '执行中', tone: 'info' },
  { id: 'AWAITING', label: '待验收', tone: 'warn' },
  { id: 'DONE', label: '已完成', tone: 'ok' },
]
const KANBAN_SIDE = [
  { id: 'SUSPENDED', label: '已挂起', tone: 'warn' },
  { id: 'TERMINATED', label: '已终止', tone: 'err' },
  { id: 'ESCALATED', label: '已升级', tone: 'err' },
]

function TaskPanel() {
  const kanban = useFetch(API + '/api/kanban')
  const local = useFetch(API + '/api/ledger/workorders')
  const { busy, msg, run } = useAction()
  const [sel, setSel] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const onDone = () => { setSel(null); local.refresh() }
  const onSyncDone = () => { kanban.refresh() }

  const loading = kanban.loading || local.loading
  const error = kanban.error || local.error
  if (loading) return el(Load, {})
  if (error) return el(ErrBox, { children: [error], onRetry: () => { kanban.refresh(); local.refresh() } })

  // paperclip issues（Q45 协议拉取）
  const kb = (kanban.data && !kanban.data.unreachable && Array.isArray(kanban.data.tasks)) ? kanban.data.tasks : []
  const kbUnreachable = kanban.data && kanban.data.unreachable
  // 本地工单
  const localAll = Array.isArray(local.data) ? local.data : []
  const localActive = localAll.filter(w => w.status === '进行中')

  // 合并显示：paperclip issues 为主，本地工单为辅（本地工单不在 paperclip 里时也显示）
  const byBucket = {}
  for (const b of [...KANBAN_BUCKETS, ...KANBAN_SIDE]) byBucket[b.id] = []
  for (const t of kb) {
    const bucket = byBucket[t.status]
    if (bucket) bucket.push({ ...t, _source: 'paperclip' })
  }

  return el('div', { children: [
    el('div', { className: 'aod-head', children: [
      el('div', { children: [
        el('h1', { className: 'aod-h1', children: ['任务看板'] }),
        el('div', { className: 'aod-sub', children: [
          kbUnreachable
            ? 'paperclip 不可达 · 仅显示本地工单'
            : 'paperclip issues ' + kb.length + ' 条 + 本地工单 ' + localActive.length + ' 条',
        ] }),
      ] }),
      el('div', { className: 'aod-btnrow', style: { marginTop: 0 }, children: [
        el(Btn, { onClick: () => onSyncDone(), children: ['刷新'] }),
        el(Btn, { kind: 'pri', onClick: () => setShowNew(v => !v), children: [showNew ? '收起' : '+ 新建本地工单'] }),
      ] }),
    ] }),

    kbUnreachable ? el('div', { className: 'aod-note', style: { color: '#d29922' }, children: [
      '⚠ paperclip 任务数据暂不可达（SSH 不可达或 psql 超时）。本地工单仍可操作。不缓存陈旧数据冒充实时（Q45 纪律）。',
    ] }) : null,

    showNew ? el(Card, { title: '新建本地工单（落 WORKORDERS.jsonl，非 paperclip）', children: [
      el(ActionForm, {
        title: '',
        fields: [
          { key: 'title', label: '工单标题', placeholder: '要做什么' },
          { key: 'assignedSeat', label: '派给席位', type: 'select', options: SEATS, default: 'ceo' },
          { key: 'priority', label: '优先级', type: 'select', options: ['P1', 'P2', 'P3'], default: 'P2' },
          { key: 'deadline', label: '截止日', type: 'date' },
        ],
        submitLabel: '派发工单',
        busy,
        onSubmit: v => { if (v.title) run('/api/action/workorder', v, () => { setShowNew(false); local.refresh() }) },
      }),
      el(Msg, { msg: msg }),
    ] }) : null,

    // 本地工单（置顶全可见——之前只计数不渲染，WO 淹没在 paperclip 里找不到）
    el(Card, { title: '本地工单（' + localAll.length + ' · 全部可见，新单在前）', children: [
      el(Tbl, {
        cols: ['工单号', '标题', '派给', '优先级', '状态', '最近回执'],
        empty: '无本地工单',
        items: localAll.slice().reverse().map(w => ({
          key: w.workOrderId,
          onClick: () => setSel(w),
          cells: [
            w.workOrderId,
            (w.title || '').slice(0, 34) + ((w.title || '').length > 34 ? '…' : ''),
            w.assignedSeat || '—',
            el(Tag, { tone: priorityTone(w.priority), children: [w.priority || '—'] }),
            el(Tag, { tone: w.status === '进行中' ? 'info' : (/终止|升级|废止/.test(String(w.status || '')) ? 'err' : 'ok'), children: [w.status || '—'] }),
            w.lastReply ? String(w.lastReply).slice(0, 26) : '—',
          ],
        })),
      }),
    ] }),

    // 四栏（paperclip issues by bucket）
    el('div', { className: 'aod-grid2', children: KANBAN_BUCKETS.map(b =>
      el(Card, { key: b.id, title: b.label + '（' + (byBucket[b.id] || []).length + '）', children: [
        el(Tbl, {
          cols: ['工单号', '标题', '派给', '优先级'],
          empty: '无',
          items: (byBucket[b.id] || []).slice(0, 50).map(t => ({
            key: t.paperclipRef,
            onClick: () => setSel(t),
            cells: [
              t.workOrderId,
              (t.title || '').slice(0, 30) + ((t.title || '').length > 30 ? '…' : ''),
              (t.assignedSeat || '').slice(0, 12),
              el(Tag, { tone: priorityTone(t.priority), children: [t.priority || '—'] }),
            ],
          })),
        }),
      ] })
    ) }),

    // 两角标栏
    el('div', { className: 'aod-grid2', children: KANBAN_SIDE.map(b =>
      el(Card, { key: b.id, title: b.label + '（' + (byBucket[b.id] || []).length + '）', children: [
        el(Tbl, {
          cols: ['工单号', '标题', '派给', '原始状态'],
          empty: '无',
          items: (byBucket[b.id] || []).slice(0, 30).map(t => ({
            key: t.paperclipRef,
            onClick: () => setSel(t),
            cells: [
              t.workOrderId,
              (t.title || '').slice(0, 30) + ((t.title || '').length > 30 ? '…' : ''),
              (t.assignedSeat || '').slice(0, 12),
              el(Tag, { tone: b.tone, children: [t.paperclipStatus || t.status] }),
            ],
          })),
        }),
      ] })
    ) }),

    // 本地工单（非 paperclip 的）
    localActive.length ? el(Card, { title: '本地工单（WORKORDERS.jsonl · 进行中）', children: [
      el(Tbl, {
        cols: ['工单号', '标题', '派给', '优先级', '截止日', '操作'],
        empty: '',
        items: localActive.map(w => ({
          key: w.workOrderId,
          onClick: () => setSel(w),
          cells: [
            w.workOrderId,
            w.title,
            w.assignedSeat,
            el(Tag, { tone: priorityTone(w.priority), children: [w.priority || '—'] }),
            fmtD(w.deadline),
            el(Tag, { tone: 'info', children: [w.status] }),
          ],
        })),
      }),
    ] }) : null,

    sel ? el(KanbanDetailDrawer, { t: sel, busy, msg, run, onDone, onClose: () => setSel(null) }) : null,
  ] })
}

function KanbanDetailDrawer({ t, busy, msg, run, onDone, onClose }) {
  const isPaperclip = t._source === 'paperclip'
  const [confirmCollab, setConfirmCollab] = useState(false)
  return el(Drawer, {
    title: t.title || t.workOrderId,
    subtitle: t.workOrderId + ' · ' + (t.paperclipStatus || t.status || ''),
    onClose,
    fields: [
      ['工单号', t.workOrderId],
      ['标题', t.title],
      ['派给', t.assignedSeat],
      ['优先级', t.priority],
      ['中枢状态', t.status],
      ['paperclip 原始状态', t.paperclipStatus || '—'],
      ['paperclipRef', t.paperclipRef || '—'],
      ['公司', t.company || '—'],
      ['项目', t.project || '—'],
      ['截止/开始日', fmtD(t.deadline)],
      ['更新于', t.updatedAt ? t.updatedAt.slice(0, 16).replace('T', ' ') : '—'],
      ['数据源', isPaperclip ? 'paperclip（经 SSH+psql 只读拉取）' : '本地 WORKORDERS.jsonl'],
    ],
    children: el(Fragment, { children: [
      !isPaperclip && (t.status === 'EXECUTING' || t.status === '进行中') ? el(ActionForm, {
        title: '终止工单（Q4 裁定：峰哥有终止权）',
        fields: [{ key: 'terminateReason', label: '终止原因', placeholder: '必填' }],
        submitLabel: '确认终止',
        busy,
        onSubmit: v => { if (v.terminateReason) run('/api/action/terminate-workorder', { workOrderId: t.workOrderId, terminateReason: v.terminateReason, terminatedBy: '峰哥' }, onDone) },
      }) : el('div', { className: 'aod-note', children: [
        isPaperclip ? 'paperclip 工单的状态变更在 PC1 paperclip 侧操作，决策中枢只读。' : '此工单当前状态不支持操作。',
      ] }),
      el('div', { className: 'aod-btnrow', children: [
        !isPaperclip && String(t.assignedSeat || '').startsWith('pc1') ? el(Btn, { kind: 'pri', disabled: busy, onClick: () => run('/api/action/dispatch-pc1', { workOrderId: t.workOrderId }, onDone), children: ['跨机派发到 PC1'] }) : null,
        !isPaperclip && !String(t.assignedSeat || '').startsWith('pc1') ? el(Btn, { kind: 'pri', onClick: () => { deliverWorkorder(t).then(ok => { if (ok) onDone() }) }, children: ['送达到席位会话'] }) : null,
        confirmCollab
          ? el(Btn, { kind: 'pri', onClick: () => { setConfirmCollab(false); try { osStartRoomFromProposal(t); onClose() } catch (err) { try { host.notifyError && host.notifyError('合议启动失败：' + (err && err.message || err)) } catch {} } }, children: ['确认发起？将创建 8 席合议群并自动开始（已有合议群则跳转不重建）'] })
          : el(Btn, { title: '从本工单创建 8 席合议群并自动开始合议（同一工单不重复建群）', onClick: () => setConfirmCollab(true), children: ['发起合议（8 席）'] }),
      ] }),
    ] }),
  })
}

// 旧 WorkorderDrawer 已由 KanbanDetailDrawer 取代（阶段2 Q45 看板协议升级）

// ══════════════════════════════════════════════════════════
// 面板 3：验收清单
// ══════════════════════════════════════════════════════════
function AcceptancePanel() {
  const { data, loading, error, refresh } = useFetch(API + '/api/ledger/acceptances')
  const { busy, msg, run } = useAction()
  const [sel, setSel] = useState(null)
  const onDone = () => { setSel(null); refresh() }

  if (loading) return el(Load, {})
  if (error) return el(ErrBox, { children: [error], onRetry: refresh })

  const all = Array.isArray(data) ? data : []

  return el('div', { children: [
    el('div', { className: 'aod-head', children: [
      el('div', { children: [
        el('h1', { className: 'aod-h1', children: ['验收清单'] }),
        el('div', { className: 'aod-sub', children: ['验收报告由 quality-auditor 签发 · 峰哥点击行给出结论（R-21：A级证据方可通过）'] }),
      ] }),
    ] }),
    el(Card, { title: '验收报告（点击行 → 通过 / 退回）', children: [
      el(Tbl, {
        cols: ['报告号', '工单/事项', '验收人', '证据分级', '结论'],
        empty: '暂无验收报告 —— 工单完工后由 quality-auditor 签发',
        items: all.map(a => ({
          key: a.reportId,
          onClick: () => setSel(a),
          cells: [
            a.reportId,
            a.title || a.workOrderId || '—',
            a.auditor || 'quality-auditor',
            el(Tag, { tone: a.evidenceGrade === 'A' ? 'ok' : 'warn', children: [a.evidenceGrade || '—'] }),
            a.verdict ? el(Tag, { tone: a.verdict === '通过' ? 'ok' : 'err', children: [a.verdict] }) : el(Tag, { tone: 'info', children: ['待结论'] }),
          ],
        })),
      }),
    ] }),
    sel ? el(AcceptanceDrawer, { a: sel, busy, msg, run, onDone, onClose: () => setSel(null) }) : null,
  ] })
}

function AcceptanceDrawer({ a, busy, msg, run, onDone, onClose }) {
  return el(Drawer, {
    title: '验收报告 ' + a.reportId,
    subtitle: a.title || '',
    onClose,
    fields: [
      ['报告号', a.reportId],
      ['工单号', a.workOrderId],
      ['事项', a.title],
      ['验收人', a.auditor],
      ['证据分级', a.evidenceGrade],
      ['证据说明', a.evidenceNote],
      ['当前结论', a.verdict || '待结论'],
      ['重做指令', a.reworkInstructions],
    ],
    children: a.verdict ? null : el(Fragment, { children: [
      el(ActionForm, {
        title: '验收结论',
        fields: [
          { key: 'verdict', label: '结论', type: 'select', options: ['通过', '退回'], default: '通过' },
          { key: 'reworkInstructions', label: '重做指令（退回时必填）', placeholder: '退回时给执行席位的整改指令' },
        ],
        submitLabel: '提交结论',
        busy,
        onSubmit: v => {
          if (v.verdict === '退回' && !v.reworkInstructions) { return }
          run('/api/action/acceptance-verdict', { reportId: a.reportId, verdict: v.verdict, reworkInstructions: v.reworkInstructions || '' }, onDone)
        },
      }),
      el(Msg, { msg: msg }),
    ] }),
  })
}

// ══════════════════════════════════════════════════════════
// 面板 4：决策对账（REP-05 口径 · Q8 append-only：更正=追加行）
// ══════════════════════════════════════════════════════════
function latestRecon(rows, id) {
  let last = null
  for (const r of rows) if (r.type === 'recon' && r.decisionId === id) last = r
  return last
}

function nextDueDate(d) {
  const cands = [d['对账日_30天'], d['对账日_90天'], d['对账日_180天']].filter(Boolean).sort()
  for (const c of cands) if (c >= today()) return c
  return cands[cands.length - 1] || null
}

function RulingsCard() {
  const { data, loading, error, refresh } = useFetch(API + '/api/ledger/rulings')
  const { busy, msg, run } = useAction()
  const [sel, setSel] = useState(null)
  const onDone = () => { setSel(null); refresh() }
  if (loading) return el(Load, {})
  if (error) return el(ErrBox, { children: [error], onRetry: refresh })
  const rows = Array.isArray(data) ? data : []
  const decisions = rows.filter(r => r.type === 'decision')
  return el(Card, { title: '决策对账（REP-05 · 30/90/180 天回问 · 点击行登记对账）', children: [
    el(Tbl, {
      cols: ['裁定编号', '档位', '裁定日', '事项', '对账日', '回看结果'],
      empty: '决策账暂无裁定行',
      items: decisions.map(d => {
        const recon = latestRecon(rows, d.id)
        const due = nextDueDate(d)
        return {
          key: d.id,
          onClick: () => setSel(d),
          cells: [
            d.id,
            el(Tag, { tone: d['档位'] === 'L0' ? 'info' : d['档位'] === 'L1' ? 'warn' : 'mute', children: [d['档位'] || '—'] }),
            fmtD(d['裁定日']),
            (d['事项'] || '').slice(0, 24) + ((d['事项'] || '').length > 24 ? '…' : ''),
            fmtD(due),
            recon
              ? el(Tag, { tone: recon.verdict === '判断正确' ? 'ok' : 'err', children: [recon.verdict] })
              : due && due < today()
                ? el(Tag, { tone: 'warn', children: ['待回问'] })
                : el(Tag, { tone: 'mute', children: [d['对账状态'] || '未到期'] }),
          ],
        }
      }),
    }),
    el(Msg, { msg: msg }),
    sel ? el(ReconDrawer, { d: sel, rows, busy, msg, run, onDone, onClose: () => setSel(null) }) : null,
  ] })
}

function ReconDrawer({ d, rows, busy, msg, run, onDone, onClose }) {
  const recon = latestRecon(rows, d.id)
  return el(Drawer, {
    title: d['事项'] || d.id,
    subtitle: d.id + ' · ' + (d['档位'] || ''),
    onClose,
    fields: [
      ['裁定编号', d.id],
      ['档位', d['档位']],
      ['裁定日', fmtD(d['裁定日'])],
      ['目标锚', d['目标锚']],
      ['参与者', Array.isArray(d['参与者']) ? d['参与者'].join('、') : d['参与者']],
      ['依据', Array.isArray(d['依据']) ? d['依据'].join('；') : d['依据']],
      ['结论', d['结论']],
      ['对账日(30/90/180)', [d['对账日_30天'], d['对账日_90天'], d['对账日_180天']].filter(Boolean).join(' / ')],
      ['对账状态', recon ? recon.verdict + '（' + fmtD(recon.reconAt) + '）' : (d['对账状态'] || '未到期')],
      ['更正记录', recon && recon.verdict === '需更正' ? recon.note : '—'],
    ],
    children: el(Fragment, { children: [
      el('div', { className: 'aod-btnrow', children: [
        el(Btn, { kind: 'pri', disabled: busy, onClick: () => run('/api/action/recon', { decisionId: d.id, verdict: '判断正确' }, onDone), children: ['登记对账：判断正确'] }),
      ] }),
      el(ActionForm, {
        title: '需更正（Q8：追加更正行，不改历史）',
        fields: [{ key: 'note', label: '更正说明', placeholder: '必填：哪里判断错了' }],
        submitLabel: '登记需更正',
        busy,
        onSubmit: v => { if (v.note) run('/api/action/recon', { decisionId: d.id, verdict: '需更正', note: v.note }, onDone) },
      }),
      el(Msg, { msg: msg }),
    ] }),
  })
}

// ══════════════════════════════════════════════════════════
// 面板 5：承诺账
// ══════════════════════════════════════════════════════════
function CommitmentPanel() {
  const { data, loading, error, refresh } = useFetch(API + '/api/ledger/commitments')
  const { busy, msg, run } = useAction()
  const [sel, setSel] = useState(null)
  const [filter, setFilter] = useState('open')
  const [showNew, setShowNew] = useState(false)
  const onDone = () => { setSel(null); refresh() }

  if (loading) return el(Load, {})
  if (error) return el(ErrBox, { children: [error], onRetry: refresh })

  const all = Array.isArray(data) ? data : []
  const rows = filter === 'open' ? all.filter(c => !c._closed) : all

  return el('div', { children: [
    el('div', { className: 'aod-head', children: [
      el('div', { children: [
        el('h1', { className: 'aod-h1', children: ['账本'] }),
        el('div', { className: 'aod-sub', children: ['决策对账（面板4）+ 承诺账（面板5）· COMMITMENTS.csv 未销号 ' + all.filter(c => !c._closed).length + ' / 总 ' + all.length] }),
      ] }),
      el('div', { className: 'aod-btnrow', style: { marginTop: 0 }, children: [
        el(Btn, { onClick: () => setFilter(filter === 'open' ? 'all' : 'open'), children: [filter === 'open' ? '承诺看全部' : '承诺只看未销号'] }),
        el(Btn, { kind: 'pri', onClick: () => setShowNew(v => !v), children: [showNew ? '收起' : '+ 登记承诺'] }),
      ] }),
    ] }),

    el(RulingsCard, { key: 'rulings' }),

    showNew ? el(Card, { title: '登记承诺', children: [
      el(ActionForm, {
        title: '',
        fields: [
          { key: '事项', label: '承诺事项', placeholder: '必填' },
          { key: '负责人', label: '负责人（席位）', type: 'select', options: SEATS, default: 'ceo' },
          { key: '截止日', label: '截止日', type: 'date', default: today() },
          { key: '类型', label: '类型', type: 'select', options: ['治理', '业务', '开发', '跨机'], default: '业务' },
          { key: '建议动作', label: '建议动作', type: 'select', options: ['执行', '改期', '撤销'], default: '执行' },
          { key: '理由', label: '理由', placeholder: '选填' },
        ],
        submitLabel: '登记',
        busy,
        onSubmit: v => { if (v['事项'] && v['负责人'] && v['截止日']) run('/api/action/commitment', v, () => { setShowNew(false); refresh() }) },
      }),
      el(Msg, { msg: msg }),
    ] }) : null,

    el(Card, { title: '承诺清单（点击行 → 销号）', children: [
      el(Tbl, {
        cols: ['#', '事项', '负责人', '截止日', '类型', '归宿'],
        empty: filter === 'open' ? '全部承诺已销号' : '空',
        items: rows.map(c => ({
          key: c['序号'],
          onClick: () => setSel(c),
          cells: [
            '#' + c['序号'],
            c['事项'],
            c['负责人'],
            el(Tag, { tone: !c._closed && c['截止日'] && c['截止日'] < today() ? 'err' : c._closed ? 'ok' : 'mute', children: [fmtD(c['截止日'])] }),
            c['类型'] || '—',
            c._closed ? el(Tag, { tone: 'ok', children: [c['归宿'] || '已销号'] }) : el(Tag, { tone: 'warn', children: ['未销号'] }),
          ],
        })),
      }),
    ] }),

    sel ? el(CommitmentDrawer, { c: sel, busy, msg, run, onDone, onClose: () => setSel(null) }) : null,
  ] })
}

// ══════════════════════════════════════════════════════════
// 面板 5：经营面板
// ══════════════════════════════════════════════════════════
function FinancePanel() {
  const { data, loading, error, refresh } = useFetch(API + '/api/finance')
  const { busy, msg, run } = useAction()
  const [view, setView] = useState('flows')

  if (loading) return el(Load, {})
  if (error) return el(ErrBox, { children: [error], onRetry: refresh })

  const rev = (data && data.revenue) || []
  const exp = (data && data.expense) || []
  const sum = arr => arr.reduce((a, r) => a + (Number(r.amountCents) || 0), 0)
  const mkey = today().slice(0, 7)
  const mRev = sum(rev.filter(r => String(r.occurredAt || '').startsWith(mkey)))
  const mExp = sum(exp.filter(r => String(r.occurredAt || '').startsWith(mkey)))
  const flows = []
    .concat(rev.map(r => ({ ...r, _type: '收入' })))
    .concat(exp.map(r => ({ ...r, _type: '费用' })))
    .sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')))

  // 财务三表口径（REP-07 · R-22 收付实现制 · INV-01 恒等）
  const byLine = {}
  for (const r of rev) { const k = r.productLine || '其他'; byLine[k] = (byLine[k] || 0) + (Number(r.amountCents) || 0) }
  const byCat = {}
  for (const r of exp) { const k = r.category || '其他'; byCat[k] = (byCat[k] || 0) + (Number(r.amountCents) || 0) }
  const revTotal = sum(rev)
  const costTotal = (byCat['人力'] || 0) + (byCat['场地'] || 0)
  const depTotal = byCat['折旧'] || 0
  const opexTotal = (byCat['运营'] || 0) + (byCat['其他'] || 0)
  const purchTotal = byCat['采购'] || 0
  const expAll = costTotal + depTotal + opexTotal + purchTotal
  const netProfit = revTotal - expAll
  const operFlow = revTotal - (costTotal + opexTotal)
  const investFlow = -(purchTotal + depTotal)
  const cash = revTotal - expAll
  const stmtBtn = (id, label) => el(Btn, {
    key: id, kind: view === id ? 'pri' : null, onClick: () => setView(id), children: [label],
  })
  const stmtRow = (label, value, opts) => el('tr', { key: label, children: [
    el('td', { style: { border: 'none', padding: '5px 8px', opacity: opts && opts.dim ? 0.6 : 1, fontWeight: opts && opts.sum ? 600 : 400, paddingLeft: opts && opts.indent ? 22 : 8 }, children: [label] }),
    el('td', { style: { border: 'none', padding: '5px 8px', textAlign: 'right', fontWeight: opts && opts.sum ? 700 : 400, color: opts && opts.tone === 'err' ? '#f85149' : opts && opts.tone === 'ok' ? '#3fb950' : null }, children: [value] }),
  ] })
  const Stmt = ({ note, rows }) => el('div', { children: [
    el('table', { className: 'aod-tbl', children: [el('tbody', { children: rows })] }),
    note ? el('div', { className: 'aod-note', children: [note] }) : null,
  ] })

  return el('div', { children: [
    el('div', { className: 'aod-head', children: [
      el('div', { children: [
        el('h1', { className: 'aod-h1', children: ['经营面板'] }),
        el('div', { className: 'aod-sub', children: ['财务流水账 finance/*.jsonl · 三张报表视图在里程碑②接入（Q35/Q49）'] }),
      ] }),
    ] }),

    el('div', { className: 'aod-stats', children: [
      el(Stat, { label: '累计收入', value: fen(sum(rev)), tone: 'ok' }),
      el(Stat, { label: '累计支出', value: fen(sum(exp)), tone: 'err' }),
      el(Stat, { label: '累计净额', value: fen(sum(rev) - sum(exp)) }),
      el(Stat, { label: '本月净额（' + mkey + '）', value: fen(mRev - mExp) }),
    ] }),

    el('div', { className: 'aod-grid2', children: [
      el(Card, { title: '录收入', children: [
        el(ActionForm, {
          title: '',
          fields: [
            { key: 'productLine', label: '产品线', default: 'GEO119' },
            { key: 'amount', label: '金额（元）', type: 'number', placeholder: '如 1200.50' },
            { key: 'occurredAt', label: '发生日期', type: 'date', default: today() },
            { key: 'voucherRef', label: '凭证号（选填）', placeholder: '如 支付宝流水号' },
          ],
          submitLabel: '录入',
          busy,
          onSubmit: v => {
            const cents = yuanToCents(v.amount)
            if (cents == null) { return }
            run('/api/action/revenue', { amountCents: cents, productLine: v.productLine || 'GEO119', occurredAt: v.occurredAt || today(), voucherRef: v.voucherRef || '' }, refresh)
          },
        }),
      ] }),
      el(Card, { title: '录费用', children: [
        el(ActionForm, {
          title: '',
          fields: [
            { key: 'category', label: '费用类别', type: 'select', options: EXPENSE_CATEGORIES, default: '运营' },
            { key: 'amount', label: '金额（元）', type: 'number', placeholder: '如 2000' },
            { key: 'occurredAt', label: '发生日期', type: 'date', default: today() },
            { key: 'voucherRef', label: '凭证号（选填）', placeholder: '' },
          ],
          submitLabel: '录入',
          busy,
          onSubmit: v => {
            const cents = yuanToCents(v.amount)
            if (cents == null) { return }
            run('/api/action/expense', { amountCents: cents, category: v.category, occurredAt: v.occurredAt || today(), voucherRef: v.voucherRef || '' }, refresh)
          },
        }),
      ] }),
    ] }),
    el(Msg, { msg: msg }),
    el('div', { className: 'aod-note', children: ['固定成本口径（Q35）：人力 ¥20,000/月 · 场地 ¥2,000/月 · PC 固定资产折旧 —— 需按月手工录入费用，系统不自动生成，避免账实分离。'] }),

    el('div', { className: 'aod-btnrow', style: { marginTop: 0, marginBottom: 10 }, children: [
      stmtBtn('flows', '流水'), stmtBtn('income', '利润表'), stmtBtn('cashflow', '现金流量表'), stmtBtn('balance', '资产负债表'),
    ] }),

    view === 'flows' ? el(Card, { title: '收支流水', children: [
      el(Tbl, {
        cols: ['类型', '单号', '金额', '明细', '发生日', '凭证'],
        empty: '暂无流水',
        items: flows.map(r => ({
          key: r.recordId,
          onClick: null,
          cells: [
            el(Tag, { tone: r._type === '收入' ? 'ok' : 'err', children: [r._type] }),
            r.recordId,
            fen(r.amountCents),
            r.productLine || r.category || '—',
            fmtD(r.occurredAt),
            r.voucherRef || '—',
          ],
        })),
      }),
    ] }) : null,

    view === 'income' ? el(Card, { title: '利润表（收付实现制 · REP-07）', children: [
      el(Stmt, {
        rows: [
          stmtRow('收入', '', { sum: true }),
          ...Object.keys(byLine).map(k => stmtRow(k, fen(byLine[k]), { indent: true })),
          stmtRow('收入合计', fen(revTotal), { sum: true, tone: 'ok' }),
          stmtRow('成本（人力+场地）', fen(costTotal)),
          stmtRow('费用（运营+其他+采购）', fen(opexTotal + purchTotal)),
          stmtRow('折旧（摊销口径，按已录入流水计）', fen(depTotal)),
          stmtRow('净利 = 收入 −（成本+费用+折旧）', fen(netProfit), { sum: true, tone: netProfit >= 0 ? 'ok' : 'err' }),
        ],
        note: '产品线未产生收入前此表为实算口径展示（Q42：每笔账强制原始凭证引用）。',
      }),
    ] }) : null,

    view === 'cashflow' ? el(Card, { title: '现金流量表（收付实现制 · R-22）', children: [
      el(Stmt, {
        rows: [
          stmtRow('经营活动现金流（收入 − 人力/场地/运营/其他）', fen(operFlow), { tone: operFlow >= 0 ? 'ok' : 'err' }),
          stmtRow('投资活动现金流（采购+折旧摊销）', fen(investFlow), { tone: investFlow >= 0 ? 'ok' : 'err' }),
          stmtRow('筹资活动现金流（未接入）', fen(0)),
          stmtRow('净现金流（=期末现金余额）', fen(cash), { sum: true, tone: cash >= 0 ? 'ok' : 'err' }),
        ],
        note: '现阶段=经营流为主；折旧为摊销口径暂按已录入流水计，FUNC-21 折旧模块接入后自动按资产账计提。',
      }),
    ] }) : null,

    view === 'balance' ? el(Card, { title: '资产负债表（INV-01：资产 = 负债 + 所有者权益）', children: [
      el(Stmt, {
        rows: [
          stmtRow('货币资金（=累计净现金流）', fen(cash)),
          stmtRow('应收账款（未接入）', fen(0)),
          stmtRow('固定资产净值（资产账未接入，原值−累计折旧=0）', fen(0)),
          stmtRow('资产合计', fen(cash), { sum: true }),
          stmtRow('负债（未接入）', fen(0)),
          stmtRow('所有者权益（OPC：峰哥一人）', fen(cash), { sum: true }),
          stmtRow('恒等校验：资产 = 负债 + 权益 → ' + (Math.abs(cash - (0 + cash)) < 0.01 ? '通过 ✓' : '失配 ✗'), '', { dim: true }),
        ],
        note: 'INV-01 恒等校验当前恒通过（收付实现制下权益=现金）。固定资产台账与应收接入后自动带出净值。',
      }),
    ] }) : null,
  ] })
}

// ══════════════════════════════════════════════════════════
// 面板 6：运营面板（中枢运营=真数据聚合 · GEO119 产品运营=埋点未接入预留）
// ══════════════════════════════════════════════════════════
const ESC_OPEN_STATES = ['已执行', '默认项已执行', '已否决', '已关闭']

function OpsPanel() {
  const pending = useFetch(API + '/api/ledger/pending')
  const wo = useFetch(API + '/api/ledger/workorders')
  const esc = useFetch(API + '/api/ledger/escalations')
  const search = useFetch(API + '/api/search')
  const sentinel = useFetch(API + '/api/sentinel')
  const patrol = useFetch(API + '/api/patrol')
  const audit = useFetch(API + '/api/audit/weekly')

  if (pending.loading || wo.loading || esc.loading || search.loading) return el(Load, {})
  const firstErr = [pending, wo, esc, search].find(h => h.error)
  if (firstErr) return el(ErrBox, { children: [firstErr.error], onRetry: () => [pending, wo, esc, search].forEach(h => h.refresh()) })

  const s = (pending.data && pending.data.summary) || {}
  const commitments = (pending.data && pending.data.commitments) || []
  const overdueC = commitments.filter(c => c['截止日'] && c['截止日'] < today()).length
  const wos = Array.isArray(wo.data) ? wo.data : []
  const woActive = wos.filter(w => w.status === '进行中').length
  const escAll = Array.isArray(esc.data) ? esc.data : []
  const escOpen = escAll.filter(e => !ESC_OPEN_STATES.includes(e.status)).length
  const entries = (search.data && search.data.entries) || []
  const byModel = {}
  for (const e of entries) { const k = String(e.model || '—').slice(0, 2).toUpperCase() || '—'; byModel[k] = (byModel[k] || 0) + 1 }

  // 哨兵族数据
  const tickerStates = (sentinel.data && sentinel.data.tickerStates) || {}
  const tickerOk = Object.values(tickerStates).filter(v => v === 'ok').length
  const tickerTotal = Object.keys(tickerStates).length
  const stormAlerts = (sentinel.data && sentinel.data.stormAlerts) || 0
  const patrolAlerts = (patrol.data && patrol.data.alerts) || []
  const patrolAt = (patrol.data && patrol.data.lastSuccessAt) || '—'
  const auditAt = (audit.data && audit.data.lastSuccessAt) || '—'
  const sentinelAt = (sentinel.data && sentinel.data.heartbeatAt) || '—'

  return el('div', { children: [
    el('div', { className: 'aod-head', children: [
      el('div', { children: [
        el('h1', { className: 'aod-h1', children: ['运营面板'] }),
        el('div', { className: 'aod-sub', children: ['中枢运营=实时聚合（Q28 即时口径）· 哨兵族已暴露 · GEO119 产品运营=埋点未接入（Q43）'] }),
      ] }),
    ] }),

    el('div', { className: 'aod-stats', children: [
      el(Stat, { label: '悬决数', value: s.pendingCount || 0, tone: (s.pendingCount || 0) > 0 ? 'err' : 'ok' }),
      el(Stat, { label: '未销号承诺（逾期' + overdueC + '）', value: commitments.length, tone: overdueC ? 'err' : 'ok' }),
      el(Stat, { label: '升级单待决（总' + escAll.length + '）', value: escOpen }),
      el(Stat, { label: '工单进行中（总' + wos.length + '）', value: woActive }),
      el(Stat, { label: '本体条目', value: entries.length }),
      el(Stat, { label: 'Ticker健康（' + tickerOk + '/' + tickerTotal + '）', value: tickerOk + '/' + tickerTotal, tone: tickerOk === tickerTotal ? 'ok' : 'err' }),
    ] }),

    el(Card, { title: '中枢运营读数（现有数据可接）', children: [
      el(Tbl, {
        cols: ['读数', '当前值', '口径说明'],
        items: [
          { key: 'p', onClick: null, cells: ['悬决数', s.pendingCount || 0, '未闭提案+未决升级单+未销号承诺（REP-01）'] },
          { key: 'c', onClick: null, cells: ['承诺执行中 / 逾期', commitments.length + ' / ' + overdueC, 'COMMITMENTS.csv 未销号；逾期=截止日<今日（R-20 前置）'] },
          { key: 'e', onClick: null, cells: ['升级单 待决 / 累计', escOpen + ' / ' + escAll.length, 'ESCALATIONS.jsonl；待决=未到四种闭环态'] },
          { key: 'w', onClick: null, cells: ['工单 进行中 / 累计', woActive + ' / ' + wos.length, '本地 WORKORDERS.jsonl + paperclip 看板（Q45）双源'] },
          { key: 'b', onClick: null, cells: ['本体覆盖度', entries.length + ' 条', Object.keys(byModel).map(k => k + ':' + byModel[k]).join(' · ') + '（Q-06，离线索引口径）'] },
          { key: 'd1', onClick: null, cells: ['被打扰次数/周', el(Tag, { tone: 'mute', children: ['待建'] }), 'Q-02 口径；需从 ESCALATIONS.jsonl + operations_log 派生聚合（本轮未含）'] },
          { key: 'd2', onClick: null, cells: ['升级配额使用率', el(Tag, { tone: 'mute', children: ['待建'] }), 'Q-04 口径；需配额账建立后带出（本轮未含）'] },
        ],
      }),
      el('div', { className: 'aod-note', children: ['被打扰次数/周与升级配额使用率（Q-02/Q-04）显式标「待建」——无既有探针来源，不假装有数据。controller 周巡落周报快照为 Q28 另一半口径。'] }),
    ] }),

    el(Card, { title: '哨兵与巡逻（sentinel_v2 + patrol_hourly + weekly_audit）', children: [
      el(Tbl, {
        cols: ['探针族', '最后运行', '状态', '告警/摘要'],
        items: [
          { key: 's1', onClick: null, cells: [
            'sentinel_v2（模型漂移+心跳+风暴熔断）',
            fmtDT(sentinelAt),
            el(Tag, { tone: tickerOk === tickerTotal && stormAlerts === 0 ? 'ok' : 'err', children: [tickerOk + '/' + tickerTotal + ' ok' + (stormAlerts ? ' · 风暴' + stormAlerts : '')] }),
            stormAlerts ? (stormAlerts + ' 条风暴告警') : '无风暴',
          ] },
          { key: 's2', onClick: null, cells: [
            'patrol_hourly（承诺逾期+对账日扫描）',
            fmtDT(patrolAt),
            el(Tag, { tone: patrolAlerts.length ? 'warn' : 'ok', children: [patrolAlerts.length ? patrolAlerts.length + ' 条告警' : '正常运行'] }),
            patrolAlerts.length ? patrolAlerts[0].slice(0, 60) : '无告警',
          ] },
          { key: 's3', onClick: null, cells: [
            'weekly_audit（周度审计快照）',
            fmtDT(auditAt),
            el(Tag, { tone: 'info', children: ['每周一执行'] }),
            (audit.data && audit.data.latestReport) || '—',
          ] },
        ],
      }),
      el('div', { className: 'aod-note', children: ['三个探针族已在跑（sentinel_v2 每小时 / patrol_hourly 每小时 / weekly_audit 每周一），本轮新增只读端点暴露给面板——不新造探针。'] }),
    ] }),

    el(ProductMetricsCard, {}),
  ] })
}

const METRIC_TYPES = ['VISITOR_IP', 'UV', 'REG_COUNT', 'REG_RATE', 'PAY_COUNT', 'PAY_RATE', 'REG_BTN_CTR', 'PAY_BTN_CTR']

function ProductMetricsCard() {
  const { data, loading, error, refresh } = useFetch(API + '/api/product-metrics')
  const { busy, msg, run } = useAction()
  const [showNew, setShowNew] = useState(false)
  if (loading) return el(Load, {})
  if (error) return el(ErrBox, { children: [error], onRetry: refresh })
  const all = Array.isArray(data) ? data : []
  // 按指标类型分组最新值
  const latest = {}
  for (const m of all) {
    if (!latest[m.metricType] || (m.capturedAt || '') > (latest[m.metricType].capturedAt || '')) latest[m.metricType] = m
  }
  return el(Card, { title: '产品运营 · GEO119（埋点指标）', children: [
    el('div', { className: 'aod-btnrow', style: { marginTop: 0 }, children: [
      el(Btn, { kind: 'pri', onClick: () => setShowNew(v => !v), children: [showNew ? '收起' : '+ 录入指标'] }),
    ] }),
    showNew ? el(ActionForm, {
      title: '',
      fields: [
        { key: 'productLine', label: '产品线', default: 'GEO119' },
        { key: 'metricType', label: '指标类型', type: 'select', options: METRIC_TYPES, default: 'UV' },
        { key: 'value', label: '读数值', type: 'number', placeholder: '如 1234 或 0.15' },
        { key: 'period', label: '统计期（YYYYMM）', default: today().slice(0, 7).replace('-', '') },
      ],
      submitLabel: '录入',
      busy,
      onSubmit: v => {
        if (v.productLine && v.metricType && v.value) run('/api/action/product-metric', v, () => { setShowNew(false); refresh() })
      },
    }) : null,
    el(Msg, { msg: msg }),
    el(Tbl, {
      cols: ['指标类型', '最新值', '产品线', '统计期', '采集时间'],
      empty: '暂无产品运营指标 —— 埋点数据回传后自动入库',
      items: METRIC_TYPES.map(mt => {
        const m = latest[mt]
        return {
          key: mt,
          onClick: null,
          cells: [
            mt,
            m ? el(Tag, { tone: 'ok', children: [String(m.value)] }) : el(Tag, { tone: 'mute', children: ['无数据'] }),
            m ? m.productLine : '—',
            m ? m.period : '—',
            m ? fmtDT(m.capturedAt) : '—',
        ]}
      }),
    }),
    el('div', { className: 'aod-note', children: ['指标类型照 M1 OBJ-21 DICT-METRIC-TYPE（8 项，含 PAY_COUNT 付费量）。埋点数据经 PC1 侧落地 → PC2 controller cron SSH 拉取（Q45 同构纪律）。'] }),
  ] })
}

// ══════════════════════════════════════════════════════════
// 面板 7：本体检索
// ══════════════════════════════════════════════════════════
function SearchPanel() {
  const { data, loading, error } = useFetch(API + '/api/search')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(null)

  if (loading) return el(Load, {})
  if (error) return el(ErrBox, { children: [error] })

  const entries = (data && data.entries) || []
  const modelSet = new Set()
  for (const e of entries) { const m = String(e.model || '').slice(0, 2).toUpperCase(); if (m) modelSet.add(m) }
  const kw = q.trim().toLowerCase()
  const hits = kw
    ? entries.filter(e =>
        ((e.id || '') + ' ' + (e.name || '') + ' ' + (e.description || '') + ' ' + (e.keywords || []).join(' ')).toLowerCase().includes(kw))
    : entries

  return el('div', { children: [
    el('div', { className: 'aod-head', children: [
      el('div', { children: [
        el('h1', { className: 'aod-h1', children: ['本体检索'] }),
        el('div', { className: 'aod-sub', children: ['本体索引（v6 十一模型口径）· ' + entries.length + ' 条 · 覆盖 ' + modelSet.size + ' 模型 · 命中 ' + hits.length + ' 条'] }),
      ] }),
    ] }),
    el('input', {
      className: 'aod-search',
      value: q,
      onChange: e => setQ(e.target.value),
      placeholder: '搜索对象 / 行为 / 规则 / 事件 / 场景 / 映射 / 接口，如「升级单」「销号」「GEO119」',
    }),
    el(Card, { title: '索引条目（点击行 → 详情）', children: [
      el(Tbl, {
        cols: ['ID', '名称', '模型', '领域', '说明'],
        empty: '无命中条目',
        items: hits.slice(0, 200).map(e => ({
          key: e.id,
          onClick: () => setSel(e),
          cells: [
            e.id,
            e.name,
            el(Tag, { tone: 'info', children: [e.model || '—'] }),
            e.domain || '—',
            (e.description || '').slice(0, 40) + ((e.description || '').length > 40 ? '…' : ''),
          ],
        })),
      }),
    ] }),
    sel ? el(Drawer, {
      title: sel.name,
      subtitle: sel.id + ' · ' + (sel.model || ''),
      onClose: () => setSel(null),
      fields: [
        ['ID', sel.id],
        ['名称', sel.name],
        ['模型', sel.model],
        ['领域', sel.domain],
        ['说明', sel.description],
        ['关键词', (sel.keywords || []).join(' · ')],
      ],
      children: null,
    }) : null,
  ] })
}

// ══════════════════════════════════════════════════════════
// 主页面 + 注册
// ══════════════════════════════════════════════════════════
const PANELS = {
  focus: MatterFocusPanel,
  pending: PendingPanel,
  tasks: TaskPanel,
  acceptance: AcceptancePanel,
  ledger: CommitmentPanel,
  finance: FinancePanel,
  ops: OpsPanel,
  search: SearchPanel,
}

// 指挥台当前面板（全局 atom：群聊引导卡等外部入口可深链到指定面板，如 $deckTab.set('pending')）
const $deckTab = atom('pending')
// 执行追踪聚焦事项（全局 atom：{proposalId, roomId}——群聊引导卡深链定点，回答「这件事现在到哪一步、我下一步做什么」）
const $matterFocus = atom(null)

// ── 事项链路聚合（纯函数，可测）：提案 ↔ 工单（source 含 proposalId）↔ 子单完成度 ──
function matterChain(p, workorders) {
  if (!p) return { main: null, subs: [], subsDone: 0 }
  const rel = (workorders || []).filter(w => w && String(w.source || '').includes(p.proposalId))
  const main = rel.find(w => String(w.assignedSeat || '') === 'ceo') || rel[0] || null
  const subs = rel.filter(w => w !== main)
  const isDone = w => /完成|交付|闭环|已销/.test(String((w && w.status) || ''))
  return { main, subs, subsDone: subs.filter(isDone).length }
}
// 下一步规则（四态）：派单 → 等回执/拆解 → 席位执行(n/m) → 验收闭环
function nextAction(p, chain) {
  if (!p) return null
  if (!chain.main) return { kind: 'dispatch', label: '派单给 CEO 执行' }
  if (!chain.main.lastReply && !chain.subs.length) return { kind: 'await', label: '等待 CEO 回执 / 拆解' }
  if (chain.subs.length && chain.subsDone < chain.subs.length) return { kind: 'exec', label: '席位执行中（' + chain.subsDone + '/' + chain.subs.length + ' 完成）' }
  if (chain.subs.length && chain.subsDone === chain.subs.length) return { kind: 'accept', label: '子单全部完成，可验收闭环' }
  return { kind: 'await', label: '等待 CEO 拆解' }
}
// 深链定点：合议群引导卡/任何入口 → 聚焦该事项并切到执行追踪
function goFocusMatter(proposalId, roomId) {
  try { $matterFocus.set({ proposalId: proposalId || null, roomId: roomId || null }) } catch {}
  try { $deckTab.set('focus') } catch {}
  try { $view.set('deck') } catch {}
}

// 催办（desk 侧轻投递）：对 CEO 重发一行催办并等回执（依赖 merged 的 osDeliverAndAwait；standalone 降级为报错提示）
async function focusNudge(focus, chain) {
  const wo = chain && chain.main ? chain.main.workOrderId : null
  const text = '[催办 · AMM OPC ' + (wo ? '工单 ' + wo : '提案 ' + (focus && focus.proposalId)) + ' · 合议执行拆解]\n请回执一行「已受理」或「缺件：<缺什么>」，并尽快拆解为席位工单（source 需含 ' + (focus && focus.proposalId) + '）。'
  try { return await osDeliverAndAwait('ceo', text, 120000) } catch (e) { return { ok: false, error: String(e && e.message || e) } }
}

function MatterFocusPanel() {
  const focus = useValue($matterFocus)
  const allP = useFetch(API + '/api/ledger/proposals', 10000)
  const wos = useFetch(API + '/api/ledger/workorders', 10000)
  const { busy, msg, run } = useAction()
  const [nudging, setNudging] = useState(false)

  const recent = (Array.isArray(allP.data) ? allP.data : []).slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))

  if (!focus || !focus.proposalId) {
    return el('div', { children: [
      el('div', { className: 'aod-head', children: [
        el('div', { children: [
          el('h1', { className: 'aod-h1', children: ['执行追踪'] }),
          el('div', { className: 'aod-sub', children: ['单一事项全链路：提案 → 派单 → 执行 → 闭环 · 从合议群引导卡进入自动聚焦'] }),
        ] }),
      ] }),
      el(Card, { title: '最近事项（点击 → 聚焦追踪）', children: [
        el(Tbl, {
          cols: ['提案号', '标题', '阶段', '登记时间'],
          empty: allP.loading ? '加载中…' : '暂无提案——先在合议群「登记结论为提案」',
          items: recent.slice(0, 6).map(p => ({
            key: p.proposalId,
            onClick: () => $matterFocus.set({ proposalId: p.proposalId, roomId: null }),
            cells: [p.proposalId, p.title, el(Tag, { tone: stageTone(p.currentStage), children: [p.currentStage] }), fmtDT(p.createdAt)],
          })),
        }),
      ] }),
    ] })
  }

  const p = recent.find(x => x && x.proposalId === focus.proposalId) || null
  const anchorRoom = p && /合议群\s+([a-z0-9-]+)/i.exec(String(p.targetAnchor || ''))
  const roomId = focus.roomId || (anchorRoom ? anchorRoom[1] : null)
  const chain = matterChain(p, Array.isArray(wos.data) ? wos.data : [])
  const act = nextAction(p, chain)
  const stageIdx = p ? PROPOSAL_STAGES.indexOf(p.currentStage) : -1
  const nextStage = p && stageIdx >= 0 && stageIdx < PROPOSAL_STAGES.length - 1 ? PROPOSAL_STAGES[stageIdx + 1] : null

  const steps = [
    p ? { label: '提案登记', state: 'done', note: p.proposalId + ' · ' + p.currentStage } : { label: '提案登记', state: 'pending', note: '' },
    chain.main
      ? { label: '派单 CEO', state: chain.main.lastReply ? 'done' : 'doing',
          note: chain.main.lastReply ? '回执：' + String(chain.main.lastReply).slice(0, 36) : fmtDT(chain.main.createdAt) + ' 派出 · 未回执' + stuckMinutes(chain.main.createdAt) }
      : { label: '派单 CEO', state: 'pending', note: '' },
    chain.subs.length
      ? { label: '席位执行', state: chain.subsDone === chain.subs.length ? 'done' : 'doing', note: chain.subsDone + '/' + chain.subs.length + ' 子单完成' }
      : { label: '席位执行', state: 'pending', note: '' },
    chain.subs.length && chain.subsDone === chain.subs.length
      ? { label: '验收闭环', state: 'done', note: '可闭环' }
      : { label: '验收闭环', state: 'pending', note: '' },
  ]

  return el('div', { children: [
    el('div', { className: 'aod-head', children: [
      el('div', { children: [
        el('h1', { className: 'aod-h1', children: ['执行追踪'] }),
        el('div', { className: 'aod-sub', children: [(p ? p.proposalId + ' · ' : '') + (p ? p.title : '提案加载中…') + '（10s 自动刷新）'] }),
      ] }),
      el('div', { className: 'aod-btnrow', style: { marginTop: 0 }, children: [
        roomId ? el(Btn, { onClick: () => { try { $osActiveRoom.set(roomId); $view.set('chat') } catch {} }, children: ['回·合议群'] }) : null,
      ] }),
    ] }),

    el('div', { className: 'aod-steps', children: steps.map((s, i) =>
      el('div', { key: 'step' + i, className: 'aod-step ' + s.state, children: [
        el('div', { className: 'aod-step-t', children: [(s.state === 'done' ? '✅ ' : s.state === 'doing' ? '● ' : '○ ') + s.label] }),
        el('div', { className: 'aod-step-n', children: [s.note || '—'] }),
      ] })) }),

    el(Card, { title: '合议结论（' + (p ? p.proposalId : '…') + '）', children: [
      el('div', { className: 'aod-kv', children: [
        el('span', { className: 'aod-kv-k', children: ['结论摘要'] }),
        el('span', { className: 'aod-kv-v', children: [p && p.fiveItems ? p.fiveItems : '（无）'] }),
      ] }),
      nextStage ? el('div', { className: 'aod-btnrow', children: [
        el(Btn, { kind: 'pri', disabled: busy, onClick: () => run('/api/action/update-stage', { proposalId: focus.proposalId, newStage: nextStage }, () => allP.refresh()), children: ['推进至「' + nextStage + '」'] }),
      ] }) : null,
      el(Msg, { msg: msg }),
    ] }),

    chain.main ? el(Card, { title: '执行工单 ' + chain.main.workOrderId + (chain.subs.length ? '（子单 ' + chain.subsDone + '/' + chain.subs.length + ' 完成）' : ''), children: [
      el(Tbl, {
        cols: ['工单号', '标题', '派给', '状态', '截止', '最近回执'],
        empty: '—',
        items: [chain.main, ...chain.subs].map(w => ({
          key: w.workOrderId,
          cells: [
            w.workOrderId,
            (w.title || '').slice(0, 30),
            w.assignedSeat,
            el(Tag, { tone: w.status === '进行中' ? 'info' : (/终止|升级/.test(String(w.status || '')) ? 'err' : 'ok'), children: [w.status || '—'] }),
            fmtD(w.deadline),
            w.lastReply ? String(w.lastReply).slice(0, 28) : '—',
          ],
        })),
      }),
    ] }) : null,

    act ? el(Card, { title: '下一步', children: [
      el('div', { className: 'aod-note', children: ['当前状态：' + act.label] }),
      el('div', { className: 'aod-btnrow', children: [
        act.kind === 'dispatch' && roomId ? el(Btn, { kind: 'pri', disabled: busy, onClick: () => { try { osDispatchToCeo(roomId); allP.refresh(); wos.refresh() } catch {} }, children: ['派单给 CEO 执行'] }) : null,
        act.kind === 'await' ? el(Btn, { kind: 'pri', disabled: nudging, onClick: async () => { setNudging(true); const r = await focusNudge(focus, chain); setNudging(false); try { host.notify && host.notify(r.ok ? '催办已送达，CEO 已回执' : '催办未确认：' + (r.error || '')) } catch {} }, children: [nudging ? '催办中…' : '催办重发（等回执）'] }) : null,
        act.kind === 'accept' ? el(Btn, { kind: 'pri', disabled: busy, onClick: () => run('/api/action/update-stage', { proposalId: focus.proposalId, newStage: '已裁定' }, () => allP.refresh()), children: ['验收并闭环'] }) : null,
        act.kind === 'exec' ? el('span', { className: 'aod-note', children: ['执行明细见上方工单卡；子单完成会自动亮起验收。'] }) : null,
      ] }),
    ] }) : null,
  ] })
}

// 卡住时长提示（派单超过 10 分钟未回执才显示，避免刚点完就红）
function stuckMinutes(createdAt) {
  const t = Date.parse(String(createdAt || '').replace(' ', 'T'))
  if (isNaN(t)) return ''
  const mins = Math.floor((Date.now() - t) / 60000)
  return mins >= 10 ? ' · 已 ' + mins + ' 分钟' : ''
}

function DeskHome() {
  const tab = useValue($deckTab)
  const P = PANELS[tab] || PendingPanel
  return el('div', { className: 'aod-page', children: [
    el('div', { key: 'tabs', className: 'aod-tabs', children:
      TABS.map(t => el('button', {
        key: t.id,
        className: 'aod-tab' + (t.id === tab ? ' on' : ''),
        onClick: () => $deckTab.set(t.id),
        children: [t.label],
      })) }),
    el(P, { key: 'panel-' + tab }),
  ] })
}

function OfficeFloor() {
  const { data, error, isLoading, refetch } = useRoster()
  const turnBusy = useTurnBusy()
  const activeProfile = (useValue(focusedProfileState) || 'default').trim() || 'default'
  useValue($avatars)
  const jobs = useValue($jobs)
  const hasTransientWork = Object.values(jobs).some(row => row && (row.state === JOB_STATES.SUBMITTING || row.state === JOB_STATES.RUNNING))
  const now = usePulse(hasTransientWork ? 200 : 1000)
  const night = isNightHour(new Date(now))
  const sky = skyState(new Date(now))
  const peek = useValue($peekUntil) > now
  const backdrop = useValue($backdrop)
  const trophies = useValue($trophies)
  const hint = useValue($hint)
  const week = useValue($week)
  const roomRef = useRef(null)
  const roster = Array.isArray(data?.profiles) ? data.profiles : []
  const selected = resolvePicked(roster, useValue($selected), activeProfile)
  const inputRequests = useValue($officeInput)
  const inputBots = roster.filter(bot => inputRequests[bot.name] && jobIsActive(jobs[bot.name]))
  const working = roster.filter(bot => jobs[bot.name] && (jobs[bot.name].state === JOB_STATES.SUBMITTING || jobs[bot.name].state === JOB_STATES.RUNNING))
  const attention = roster.filter(bot => jobs[bot.name] && (jobs[bot.name].state === JOB_STATES.FAILED || jobs[bot.name].state === JOB_STATES.UNKNOWN))
  const externalBusy = turnBusy && !working.length
  const idleCount = idleBotNames(roster, jobs, activeProfile, turnBusy).length
  const news = useValue($news)
  const newsNames = roster.map(bot => bot.name).filter(name => news[name])
  const nameOf = name => {
    const bot = roster.find(row => row.name === name)
    return bot ? botLook(bot).title : name
  }

  useEffect(() => {
    pullAvatars(roster)
  }, [roster])

  // Reattach only persisted, owner-bound work. Runtime ids are ephemeral but
  // the stored id is durable, so the fallback poll can reacquire liveness after
  // a plugin reload without ever resubmitting the prompt.
  useEffect(() => {
    for (const [name, row] of Object.entries(jobs)) {
      if (!jobIsActive(row) || jobPollers.has(name) || !row.storedSessionId) continue
      watchJob(name, row.id)
    }
  }, [jobs])

  useEffect(() => {
    tickRoam(now, roomRef.current, { jobs, rosterNames: roster.map(bot => bot.name) })
  }, [now, jobs, roster])

  useEffect(() => {
    tickNight(now, night, roster, jobs, activeProfile, turnBusy)
  }, [now, night, roster, jobs, activeProfile, turnBusy])

  useEffect(() => {
    seedTrophies(roster)
    seedMonth(roster)
  }, [roster, trophies])

  useEffect(() => {
    const due = ritualDue($ritual.get(), new Date(now))
    if (due >= 0 && roster.length) {
      runRitual(roster, jobs, activeProfile, turnBusy, due)
    }
  }, [now, roster, jobs, activeProfile, turnBusy])

  // Keyboard: arrows nudge the picked bot, Enter opens its chat, P pets it.
  // Ignored while typing in a field.
  useEffect(() => {
    const onKey = event => {
      const tag = event.target?.tagName
      const interactive = event.target?.closest?.('button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="option"]')
      if (event.defaultPrevented || event.repeat || interactive || event.target?.isContentEditable || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      const bot = roster.find(row => row.name === selected)
      if (!bot || !roomRef.current) {
        return
      }

      const step = event.shiftKey ? 48 : 24
      const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }

      if (arrows[event.key]) {
        event.preventDefault()
        if (jobIsActive(jobs[bot.name]) || $game.get()) {
          return
        }
        const [dx, dy] = arrows[event.key]
        const from = currentPos(bot.name, roomRef.current)
        if (!from) {
          return
        }
        const box = roamBox(roomRef.current)
        const next = {
          x: Math.max(box.x0, Math.min(box.x1, from.x + dx)),
          y: Math.max(box.y0, Math.min(box.y1, from.y + dy))
        }
        clearRoam(bot.name)
        setWalk(bot.name, null)
        saveSeats({ ...$seats.get(), [bot.name]: next })
        patchFx(bot.name, { atBar: false, lingerUntil: 0, nap: false })
        dismissHint()
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        void openBot(bot)
        return
      }

      if (event.key === 'p' || event.key === 'P') {
        event.preventDefault()
        const at = Date.now()
        patchFx(bot.name, { petUntil: at + 900, stretchUntil: at + 700, closerUntil: at + 2600, nap: false, idleSince: 0 })
        dismissHint()
        tap()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [roster, selected, jobs])

  useEffect(() => () => stopMusicalChairs(), [])
  useEyeTracking(roomRef)

  const onFloor = event => {
    const mark = event.target?.classList
    if (!mark) {
      return
    }

    if (mark.contains('office-room') || mark.contains('office-grid') || mark.contains('office-work') || mark.contains('office-floor')) {
      $peekUntil.set(Date.now() + 900)
    }
  }

  const playHop = () => {
    const idle = idleBotNames(roster, jobs, activeProfile, turnBusy)
    const name = idle.includes(selected) ? selected : idle[0]
    if (!name) {
      return
    }

    startHopscotch(name, roomRef.current)
    tap()
  }

  return jsxs('div', {
    className: cn('office-root', night && 'is-night', `is-${backdrop}`),
    children: [
      jsxs('header', {
        className: 'office-header',
        children: [
          jsxs('div', {
            children: [
              jsx('h1', { className: 'office-title', children: 'AMM OPC Office' })
            ]
          }),
          jsxs('div', {
            className: 'office-head-right',
            children: [
              roster.length
                ? jsx(FloorTools, {
                    roster,
                    jobs,
                    activeProfile,
                    turnBusy,
                    roomRef,
                    idleCount
                  })
                : null,
              weekLine(week)
                ? jsx('div', { className: 'office-recap', title: weekLine(week), children: weekLine(week) })
                : null,
              newsNames.length
                ? jsx('button', {
                    type: 'button',
                    className: 'office-news',
                    title: '打开聊天',
                    onClick: () => {
                      scrollToDesk(roomRef.current, newsNames[0])
                      const bot = roster.find(row => row.name === newsNames[0])
                      if (bot) {
                        void openBot(bot)
                      }
                    },
                    children: headerNames(newsNames.map(nameOf), '有新消息', '有新消息')
                  })
                : null,
              jsxs('button', {
                type: 'button',
                className: cn('office-count', (working.length || attention.length) && 'is-link'),
                title: working.length || attention.length ? '滚动到工位' : undefined,
                onClick: () => {
                  const target = inputBots[0] || working[0] || attention[0]
                  if (target) scrollToDesk(roomRef.current, target.name)
                  if (inputBots[0]) void openBot(inputBots[0])
                },
                children: [
                  jsx('span', { className: cn('office-pulse', working.length && 'is-live') }),
                  inputBots.length
                    ? headerNames(inputBots.map(bot => nameOf(bot.name)), '待输入', '待输入')
                    : working.length
                    ? headerNames(working.map(bot => nameOf(bot.name)), '工作中', '工作中')
                    : attention.length
                      ? headerNames(attention.map(bot => nameOf(bot.name)), '需要关注', '需要关注')
                      : externalBusy ? '聊天忙碌中' : roster.length ? '一片安静' : '还没有工位'
                ]
              })
            ]
          })
        ]
      }),
      jsx('div', { className: 'office-stage-wrap', children: jsxs('div', {
        className: cn('office-room', `is-${backdrop}`),
        ref: roomRef,
        onPointerDown: onFloor,
        children: [
          jsx('div', { className: 'office-wall', 'aria-hidden': true }),
          jsxs('div', { className: 'office-door', 'aria-hidden': true, children: [jsx('span', { children: '经理' }), jsx('i', {})] }),
          jsxs('div', { className: 'office-noticeboard', 'aria-hidden': true, children: [jsx('i', {}), jsx('b', {}), jsx('span', { children: '办公室便签' })] }),
          jsx('div', {
            className: 'office-live-status',
            role: 'status',
            'aria-live': 'polite',
            children: inputBots.length
              ? `${inputBots.map(bot => nameOf(bot.name)).join(', ')} 需要输入。打开其聊天以回应。`
              : working.length
              ? `${working.map(bot => nameOf(bot.name)).join(', ')} 正在工作`
              : attention.length
                ? `${attention.map(bot => nameOf(bot.name)).join(', ')} 需要关注`
                : externalBusy ? '办公室外的聊天正忙。' : ''
          }),
          jsx('div', { className: cn('office-plant', working.length && 'is-lean'), 'aria-hidden': true }),
          jsx(Ambience, { backdrop, tally: Object.values(trophies).reduce((a, b) => a + b, 0), sky, roster, trophies }),
          hint === 'task' || hint === 'play' ? jsx(HintBubble, { roster, stage: hint, selectedName: selected, onClose: dismissHint }) : null,
          jsx(OfficeProps, {
            now,
            roomRef,
            onReplay: () => {
              const state = $ritual.get()
              if (ritualReplayable(state, Date.now()) && !roster.some(bot => ($fx.get()[bot.name]?.ritualUntil || 0) > Date.now())) {
                runRitual(roster, jobs, activeProfile, turnBusy)
              }
            }
          }),
          jsx(GameChairs, {}),
          jsx(Puffs, {}),
          jsx(OfficeBoss, {}),
          isLoading
            ? jsx('div', { className: 'office-empty', children: '正在打开办公室…' })
            : error
              ? jsxs('div', {
                  className: 'office-empty',
                  children: ['无法加载机器人。 ', jsx('button', { type: 'button', className: 'office-retry', onClick: () => void refetch(), children: '重试' })]
                })
              : roster.length === 0
                ? jsx('div', {
                    className: 'office-empty',
                    children: '还没有机器人。请先在 Bot Mode 中创建一个，再回来。'
                  })
                : jsxs(Fragment, {
                    children: [
                      jsxs('div', {
                        className: 'office-floor',
                        children: [
                          jsx('div', {
                            className: 'office-work',
                            children: jsx('div', {
                              className: 'office-grid',
                              children: roster.map(bot =>
                                jsx(
                                  Desk,
                                  {
                                    bot,
                                    isActive: bot.name === activeProfile,
                                    turnBusy,
                                    tasked: jobIsActive(jobs[bot.name]),
                                    taskState: jobs[bot.name]?.state,
                                    picked: bot.name === selected,
                                    roomRef,
                                    night,
                                    peek,
                                    now,
                                    onPick: () => pickBot(bot.name),
                                    onOpen: () => void openBot(bot)
                                  },
                                  bot.name
                                )
                              )
                            })
                          }),
                          jsx(Hopscotch, { onHop: playHop, now }),
                          jsx(OfficeBar, { count: roster.length, now }),
                          jsx(OfficeLifeScene, { roster, jobs, activeProfile, turnBusy, roomRef })
                        ]
                      }),
                      jsx(Wanderers, {
                        roster,
                        isActiveName: activeProfile,
                        turnBusy,
                        jobs,
                        roomRef
                      })
                    ]
                  })
        ]
      }) }),
      roster.length ? jsx(OfficeLife, { roster, jobs, activeProfile, turnBusy, roomRef, selected }) : null,
      roster.length ? jsx(TaskBar, { roster, activeProfile }) : null,
      jsx(Planes, {})
    ]
  })
}

function OfficeChip() {
  const { data } = useRoster()
  const turnBusy = useTurnBusy()
  const activeProfile = (useValue(focusedProfileState) || 'default').trim() || 'default'
  const roster = Array.isArray(data?.profiles) ? data.profiles : []
  const jobs = useValue($jobs)
  const thinking = roster.some(
    bot => deskMood({ isActive: bot.name === activeProfile, turnBusy, tasked: jobIsActive(jobs[bot.name]) }) === 'think'
  )

  return jsx(Tip, {
    label: thinking ? '有机器人在办公室思考' : '打开办公室',
    children: jsx('button', {
      type: 'button',
      className: cn('px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)', thinking && 'text-foreground'),
      onClick: () => {
        tap()
        host.navigate('/office')
      },
      children: thinking ? '办公室 · 活跃' : '办公室'
    })
  })
}

function injectOfficeCss() {
  if (typeof document === 'undefined') {
    return
  }

  const css = `
.office-root { --office-radius:10px; --office-pill:999px; --office-card-shadow: 0 0 0 1px color-mix(in srgb, CanvasText 16%, transparent), 0 1px 0 rgba(0,0,0,.08), 0 5px 12px rgba(0,0,0,.16); --office-chip-shadow: 0 0 0 1px color-mix(in srgb, CanvasText 18%, transparent), 0 1px 3px rgba(0,0,0,.22); position:relative; display:flex; flex-direction:column; height:100%; min-height:0; background:var(--ui-bg, transparent); color:var(--ui-text-secondary); }
.office-stage-wrap { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; }
.office-recap { font-size:11px; color:var(--ui-text-tertiary); max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.office-news { height:24px; padding:0 10px; border:0; border-radius:var(--office-pill); background:color-mix(in srgb, var(--ui-accent) 16%, transparent); color:var(--ui-accent); font:inherit; font-size:11px; font-weight:600; cursor:pointer; white-space:nowrap; animation: office-hint .4s ease-out 1; }
.office-news:hover { background:color-mix(in srgb, var(--ui-accent) 26%, transparent); }
.office-count { border:0; background:transparent; font:inherit; padding:0; }
.office-count.is-link { cursor:pointer; }
.office-count.is-link:hover { color:var(--ui-text-primary, inherit); }
.office-memo { position:absolute; right:14px; top:44px; z-index:3; padding:0; border:0; background:transparent; cursor:pointer; filter: drop-shadow(0 1px 1px rgba(0,0,0,.35)); animation: office-memo .5s cubic-bezier(.2,.9,.3,1.3) 1; }
.office-memo:hover { transform: translateY(-2px) rotate(-4deg); }
.office-status.is-quiet { animation: office-quiet .5s ease 2.4s forwards; }
.office-person:hover .office-status.is-quiet, .office-person:focus-visible .office-status.is-quiet { animation:none; opacity:1; }
.office-person.is-lookup .office-eyes { transform: translate(var(--wdx, 0px), -2.6px); }
.office-hint.is-task { left:16px; top:auto; bottom:14px; }
.office-hint.is-task:before { left:22px; top:auto; bottom:-6px; box-shadow: 1px 1px 0 color-mix(in srgb, CanvasText 16%, transparent); }
.office-hint { position:absolute; left:206px; top:${WALL_H + 14}px; z-index:12; max-width:300px; display:flex; gap:8px; align-items:flex-start; padding:10px 10px 10px 12px; border-radius:var(--office-radius); background:Canvas; color:CanvasText; font-size:12px; line-height:1.4; box-shadow: var(--office-card-shadow); animation: office-hint .5s cubic-bezier(.2,.9,.3,1.2) 1; }
.office-hint b { font-weight:600; }
.office-hint:before { content:""; position:absolute; left:-6px; top:18px; width:12px; height:12px; background:Canvas; transform:rotate(45deg); box-shadow: -1px 1px 0 color-mix(in srgb, CanvasText 16%, transparent); }
.office-hint-close { flex-shrink:0; width:22px; height:22px; border:0; border-radius:99px; background:transparent; color:CanvasText; font:inherit; font-size:15px; line-height:1; cursor:pointer; opacity:.7; }
.office-hint-close:hover { opacity:1; background:color-mix(in srgb, CanvasText 10%, transparent); }
.office-sun, .office-moon { position:absolute; z-index:0; pointer-events:none; filter: drop-shadow(0 0 6px rgba(255,220,120,.6)); transition: left 60s linear, top 60s linear; }
.office-moon { filter: drop-shadow(0 0 5px rgba(244,240,216,.5)); }
.office-window { position:absolute; right:24%; top:12px; z-index:0; pointer-events:none; filter: drop-shadow(0 1px 2px rgba(0,0,0,.25)); }
.office-doodle { display:block; width:100%; height:100%; padding:2px; box-sizing:border-box; opacity:.8; }
.office-doodle-line { stroke-dasharray:60; stroke-dashoffset:60; animation: office-doodle 6s ease-in-out infinite; }
.office-face-bored { transform: translateY(5px) rotate(-7deg); }
.office-plane-layer { position:absolute; inset:0; pointer-events:none; z-index:40; overflow:hidden; }
.office-plane { position:absolute; margin:-8px 0 0 -12px; transform-origin:50% 50%; animation: office-plane .8s cubic-bezier(.3,.6,.4,1) forwards; filter: drop-shadow(0 2px 2px rgba(0,0,0,.25)); }
.office-confetti { position:absolute; left:50%; top:60px; width:0; height:0; z-index:9; pointer-events:none; }
.office-confetti i { position:absolute; left:-3px; top:-3px; width:6px; height:6px; border-radius:1px; background: hsl(calc(var(--i) * 51deg), 85%, 60%); animation: office-confetti .95s cubic-bezier(.2,.7,.4,1) forwards; --ang: calc(var(--i) * 51deg - 150deg); }
.office-stars { margin-left:6px; color:#d9a422; font-weight:600; }
.office-note { position:absolute; font-size:14px; color:CanvasText; text-shadow: 0 0 2px Canvas, 0 0 6px Canvas; animation: office-note 1.8s ease-in-out infinite; animation-delay: var(--d, 0s); opacity:0; }
.office-ding { position:absolute; top:22px; left:50%; transform:translateX(-50%); font-size:11px; font-weight:700; color:#c9302c; padding:1px 8px; border-radius:99px; animation: office-ding 1.4s ease-out forwards; z-index:4; }
.office-eom { position:absolute; left:24%; top:6px; z-index:1; display:grid; justify-items:center; gap:2px; transform-origin:50% 0; animation: office-eom-hang .9s cubic-bezier(.3,1.4,.4,1) 1; }
.office-eom-frame { width:44px; height:44px; box-sizing:border-box; padding:4px; border-radius:4px; background:linear-gradient(135deg, #f0d27a, #b8892c 45%, #f2d98a 55%, #a87a20); box-shadow: 0 2px 4px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.4); }
.office-eom-frame .office-face { width:36px; height:36px; background:#f7f2e4; border-radius:3px; }
.office-eom-plate { font-size:7px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#3a2a10; background:linear-gradient(180deg, #e8c86a, #c9a03a); padding:1px 5px; border-radius:2px; box-shadow: 0 1px 0 rgba(0,0,0,.3); white-space:nowrap; }
.office-eom-name { font-size:9px; font-weight:600; color:CanvasText; background:Canvas; padding:0 6px; border-radius:99px; box-shadow: var(--office-chip-shadow); max-width:90px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.office-tally { position:absolute; top:14px; left:50%; transform:translateX(-50%); font-size:10px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; padding:2px 8px; border-radius:99px; z-index:1; }
.office-butterfly { position:absolute; z-index:6; pointer-events:none; }
.office-butterfly.is-a { left:30%; top:40%; animation: office-fly-a 16s ease-in-out infinite; }
.office-butterfly.is-b { left:60%; top:55%; animation: office-fly-b 21s ease-in-out infinite; }
.office-wing { transform-box: fill-box; transform-origin: 100% 50%; animation: office-flap .28s ease-in-out infinite alternate; }
.office-wing.is-r { transform-origin: 0% 50%; animation-name: office-flap-r; }
.office-sweep { position:absolute; inset:0; z-index:2; pointer-events:none; mix-blend-mode:screen; background: radial-gradient(120px 90px at 20% 60%, rgba(255,79,176,.35), transparent 70%), radial-gradient(140px 100px at 70% 40%, rgba(72,224,255,.3), transparent 70%); animation: office-sweep 9s ease-in-out infinite alternate; }
.office-oven { position:absolute; right:22px; top:34px; z-index:1; }
.office-oven-fire { transform-box: fill-box; transform-origin: 50% 100%; animation: office-fire .5s ease-in-out infinite alternate; filter: drop-shadow(0 0 4px #ff8a2a); }
.office-cooler { position:absolute; left:46px; top:42px; z-index:1; }
.office-bubble { animation: office-bubble 2.4s ease-in infinite; }
.office-bubble.is-2 { animation-delay: 1.1s; animation-duration: 3s; }
.office-pendant { position:absolute; left:38%; top:0; margin-left:-15px; z-index:1; transform-origin:50% 0; animation: office-sway 4.5s ease-in-out infinite; }
.office-header { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; padding:16px 18px 10px; }
.office-kicker { font-size:10px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--ui-text-quaternary); }
.office-title { margin:2px 0 0; font-size:20px; font-weight:600; color:var(--ui-text-primary, inherit); }
.office-head-right { display:flex; align-items:center; gap:14px; }
.office-tools { display:flex; align-items:center; gap:6px; }
.office-tool { height:24px; padding:0 8px; border:1px solid var(--ui-stroke-secondary); border-radius:999px; background:transparent; color:var(--ui-text-tertiary); font:inherit; font-size:11px; cursor:pointer; }
.office-tool:hover { color:var(--ui-text-primary, inherit); }
.office-tool.is-on { border-color:var(--ui-accent); color:var(--ui-accent); }
.office-tool:disabled { opacity:.4; cursor:default; }
.office-count { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--ui-text-tertiary); }
.office-pulse { width:8px; height:8px; border-radius:99px; background:var(--ui-text-quaternary); }
.office-pulse.is-live { background:var(--ui-accent); box-shadow:0 0 0 4px color-mix(in srgb, var(--ui-accent) 22%, transparent); }
.office-taskbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; flex-shrink:0; padding:10px 16px 14px; overflow:visible; }
.office-live-status { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
.office-task-status { flex:1 1 100%; min-width:0; color:var(--ui-text-tertiary); font-size:11px; overflow-wrap:anywhere; }
.office-task-recover, .office-retry { min-height:28px; padding:4px 9px; border:1px solid var(--ui-stroke-secondary); border-radius:var(--office-radius); background:transparent; color:inherit; font:inherit; font-size:11px; cursor:pointer; }
.office-task-recover:hover, .office-retry:hover { border-color:var(--ui-accent); color:var(--ui-accent); }
.office-task-who { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--ui-text-tertiary); white-space:nowrap; }
.office-pick { position:relative; }
.office-pick-btn { max-width:160px; overflow:hidden; text-overflow:ellipsis; border:0; background:transparent; color:var(--ui-text-primary, inherit); font:inherit; cursor:pointer; padding:0 2px; }
.office-pick-btn:after { content:" ▾"; color:var(--ui-text-tertiary); }
.office-pick-menu { position:absolute; left:0; bottom:calc(100% + 6px); min-width:148px; max-height:220px; overflow:auto; z-index:30; padding:4px; border-radius:var(--office-radius); border:0; background:Canvas; color:CanvasText; box-shadow: var(--office-card-shadow), 0 10px 28px color-mix(in srgb, #000 22%, transparent); }
.office-pick-item { display:block; width:100%; text-align:left; border:0; background:transparent; color:inherit; font:inherit; font-size:12px; padding:6px 8px; border-radius:6px; cursor:pointer; }
.office-pick-item:hover, .office-pick-item.is-on { background:color-mix(in srgb, var(--ui-accent) 18%, Canvas); color:inherit; }
.office-task-input { flex:1; min-width:0; height:32px; padding:0 10px; border:1px solid var(--ui-stroke-secondary); border-radius:var(--office-radius); background:color-mix(in srgb, var(--ui-bg) 86%, transparent); color:inherit; font:inherit; }
.office-task-input:focus { outline:1px solid var(--ui-accent); }
.office-task-input:disabled { opacity:.7; }
.office-task-input.is-failed { border-color:color-mix(in srgb, #c9302c 60%, var(--ui-stroke-secondary)); }
@media (max-width: 600px) {
  .office-header { align-items:flex-start; flex-wrap:wrap; padding:12px 12px 8px; }
  .office-head-right { width:100%; min-width:0; flex-wrap:wrap; gap:7px; }
  .office-tools { flex-wrap:wrap; }
  .office-recap { max-width:100%; }
  .office-taskbar { padding:8px 12px 12px; }
  .office-task-who { flex:1 1 100%; }
  .office-task-input { flex:1 1 0; min-width:0; }
  .office-task-send, .office-task-recover { flex:0 0 auto; }
}
@media (max-width: 360px) {
  .office-title { font-size:18px; }
  .office-taskbar { gap:6px; }
  .office-task-input { flex-basis:100%; }
  .office-task-send, .office-task-recover { flex:1 1 0; }
}
.office-task-send { height:32px; padding:0 12px; border:0; border-radius:var(--office-radius); background:var(--ui-accent); color:var(--ui-accent-fg, #fff); font-size:12px; cursor:pointer; }
.office-task-send:disabled { opacity:.45; cursor:default; }
.office-desk.is-picked .office-plate { outline:1px dashed var(--ui-accent); outline-offset:1px; }
.office-room { position:relative; flex:1 1 auto; max-height:min(100%, 780px); min-height:0; margin:0 12px; overflow:auto; border:1px solid var(--ui-stroke-secondary); border-radius:12px; background:#557b8c; }
.office-wall { position:absolute; inset:0 0 auto 0; height:${WALL_H}px; pointer-events:none; }
.office-wall:after { content:""; position:absolute; left:0; right:0; top:100%; height:12px; background:linear-gradient(180deg, rgba(0,0,0,.34), rgba(0,0,0,0)); }
${Object.entries(OFFICE_SKINS).map(([name, skin]) => skinCss(name, skin)).join('\n')}
.office-plant { position:absolute; top:56px; left:18px; width:18px; height:28px; border-radius:40% 40% 20% 20%; background:#3f9f5f; box-shadow: inset -3px -2px 0 rgba(0,0,0,.18); pointer-events:none; transform-origin:50% 100%; transition:transform .6s ease; z-index:1; }
.office-plant.is-lean { transform: rotate(16deg); }
.office-plant:after { content:""; position:absolute; left:5px; bottom:-9px; width:8px; height:12px; border-radius:1px 1px 3px 3px; background:#8b5a3a; box-shadow: inset 0 1px 0 #b0805a; }
.office-clock { position:absolute; top:12px; left:50px; display:grid; justify-items:center; gap:3px; border:0; padding:0; background:transparent; color:inherit; cursor:grab; touch-action:none; z-index:5; }
.office-clock.is-digital { top:16px; }
.office-clock.is-free { top:auto; }
.office-clock:active { cursor:grabbing; }
.office-clock-lcd { min-width:52px; padding:4px 7px 3px; border-radius:4px; background:#142016; color:#9dffb0; font-size:12px; font-variant-numeric:tabular-nums; letter-spacing:.06em; box-shadow: inset 0 0 0 1px #2a3a2c, 0 1px 0 color-mix(in srgb, #000 25%, transparent); }
.office-clock-face { position:relative; width:36px; height:36px; border-radius:99px; background:
  repeating-conic-gradient(from -1deg, color-mix(in srgb, CanvasText 70%, transparent) 0 2deg, transparent 2deg 30deg),
  Canvas;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, CanvasText 30%, transparent), 0 1px 3px rgba(0,0,0,.3); }
.office-clock-hour, .office-clock-min { position:absolute; left:50%; bottom:50%; width:2px; background:CanvasText; transform-origin:50% 100%; border-radius:2px; }
.office-clock-hour { height:10px; margin-left:-1px; }
.office-clock-min { height:13px; width:1.5px; margin-left:-0.75px; opacity:.85; }
.office-clock-pin { position:absolute; left:50%; top:50%; width:4px; height:4px; margin:-2px 0 0 -2px; border-radius:99px; background:CanvasText; }
.office-clock-digits { font-size:10px; font-variant-numeric:tabular-nums; color:CanvasText; background:Canvas; padding:0 5px; border-radius:99px; box-shadow: 0 0 0 1px color-mix(in srgb, CanvasText 18%, transparent); }

.office-floor { position:relative; z-index:1; display:flex; align-items:stretch; box-sizing:border-box; min-width:560px; min-height:${WALL_H + 380}px; padding:${WALL_H + 10}px 0 16px; }
.office-work { flex:1 1 56%; min-width:0; }
.office-grid { position:relative; display:grid; grid-template-columns:repeat(auto-fill, minmax(168px, 1fr)); gap:18px; padding:8px 14px 20px; min-height:0; }
.office-aisle { flex:0 0 84px; display:flex; flex-direction:column; align-items:center; justify-content:flex-start; gap:4px; padding:10px 6px 16px; z-index:2; }
.office-chip, .office-hop-label, .office-bar-sign, .office-status, .office-home { background:Canvas; color:CanvasText; box-shadow: var(--office-chip-shadow); }
.office-hop-label { font-size:9px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; padding:1px 6px; border-radius:99px; margin-bottom:4px; }
.office-hop-row { display:flex; gap:4px; }
.office-hop { width:30px; height:28px; padding:0; border:2px solid #f6f2e6; border-radius:5px; background:color-mix(in srgb, Canvas 90%, transparent); color:CanvasText; font:inherit; font-size:11px; font-weight:700; cursor:pointer; box-shadow: 0 0 0 1px rgba(0,0,0,.32), 0 1px 3px rgba(0,0,0,.2); }
.office-hop:hover { border-color:var(--ui-accent); color:var(--ui-accent); }
.office-hop.is-lit { background:color-mix(in srgb, var(--ui-accent) 40%, Canvas); border-color:var(--ui-accent); color:CanvasText; box-shadow: 0 0 0 1px rgba(0,0,0,.32), 0 0 10px color-mix(in srgb, var(--ui-accent) 55%, transparent); transition:background .12s ease, box-shadow .12s ease; }
.office-bar { flex:0 0 148px; display:flex; flex-direction:column; align-items:center; padding:6px 10px 18px; z-index:2; }
.office-bar-sign { font-size:11px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; padding:2px 9px; border-radius:99px; margin-bottom:8px; }
.office-bar-shelf { position:relative; width:100%; height:14px; margin-top:20px; border-radius:3px 3px 0 0; background:linear-gradient(180deg, #6a4a32, #3d2a1c); box-shadow: inset 0 1px 0 #a07a55, 0 -22px 0 -1px rgba(20,28,40,.35); }
.office-bar-shelf:before, .office-bar-shelf:after { content:none; position:absolute; bottom:3px; width:5px; height:9px; border-radius:1px 1px 0 0; background:#7ec8e8; }
.office-bar-shelf:before { left:18%; background:#e86; }
.office-bar-shelf:after { left:32%; }
.office-bar-bottles { position:absolute; left:6px; right:6px; bottom:5px; height:30px; filter:drop-shadow(0 1px 1px rgba(0,0,0,.35)); }
.office-bar-counter { display:flex; justify-content:flex-end; padding-right:10px; box-sizing:border-box; width:100%; height:28px; border-radius:0 0 6px 6px; background:linear-gradient(180deg, #a3734a 0 3px, #8d623e 3px, #5a3d22); box-shadow:0 6px 0 #3d2816, 0 9px 0 #c9a24a, 0 14px 10px -2px rgba(0,0,0,.35); margin-bottom:16px; }
.office-bar-taps { position:relative; margin-top:-18px; z-index:3; filter:drop-shadow(0 2px 2px rgba(0,0,0,.3)); }
.office-bar-stools { display:flex; flex-wrap:wrap; justify-content:center; gap:10px 12px; width:100%; padding:10px 6px 12px; border-radius:12px; background:rgba(0,0,0,.16); box-shadow: inset 0 0 0 1px rgba(0,0,0,.08); }
.office-bar-stool { width:22px; height:18px; border-radius:6px 6px 3px 3px; background:linear-gradient(180deg, #a83a34 0 45%, #3a2a22 45%); box-shadow:0 3px 0 #241812, inset 0 1px 0 #d4665f, 0 6px 5px -1px rgba(0,0,0,.4); }
.office-pie { position:relative; margin-top:-16px; z-index:3; filter:drop-shadow(0 2px 2px rgba(0,0,0,.35)); }
.office-slice { position:absolute; top:-2px; left:-12px; z-index:2; transform:rotate(-20deg); filter:drop-shadow(0 1px 1px rgba(0,0,0,.35)); animation:office-slice .6s ease-in-out infinite; }
.office-status.is-sad { color:#c9302c; }
.office-person.has-pizza .office-face { animation: office-chew .55s ease-in-out infinite; }
.office-whisper.is-hi { color:var(--ui-accent); font-weight:600; animation: office-hi .3s ease-out 1; }
@keyframes office-hi { 0% { transform: translateY(4px) scale(.7); opacity:0; } 100% { transform: none; opacity:1; } }
@keyframes office-slice { 0%,100% { transform:rotate(-20deg) translateY(0); } 50% { transform:rotate(-8deg) translateY(-2px); } }
.office-game-layer { position:absolute; inset:0; pointer-events:none; z-index:4; }
.office-game-chair { position:absolute; display:block; filter:drop-shadow(0 2px 2px rgba(0,0,0,.35)); }
.office-game-chair.is-claimed { filter:drop-shadow(0 2px 2px rgba(0,0,0,.35)) drop-shadow(0 0 4px var(--ui-accent)); }
.office-empty { min-height:${WALL_H + 200}px; padding:120px 20px 40px; text-align:center; color:var(--ui-text-tertiary); font-size:13px; }
.office-desk { position:relative; display:flex; flex-direction:column; align-items:center; gap:8px; padding:8px 10px 10px; border:0; border-radius:16px; background:rgba(0,0,0,.09); box-shadow: inset 0 0 0 1px rgba(255,255,255,.10); color:inherit; text-align:center; user-select:none; -webkit-user-drag:none; }
.office-stage { position:relative; width:100%; min-height:118px; display:flex; flex-direction:column; align-items:center; }
.office-stage:before { content:""; position:absolute; left:14px; right:14px; top:84px; height:34px; border-radius:50%; background:radial-gradient(ellipse at 50% 50%, rgba(0,0,0,.30), rgba(0,0,0,0) 68%); pointer-events:none; }
.office-desk-top { position:absolute; left:8px; right:8px; top:48px; height:34px; border-radius:6px; background:#8d623e; box-shadow:0 7px 0 #5a3d22, 0 8px 0 color-mix(in srgb, #000 20%, transparent), 0 14px 10px -2px rgba(0,0,0,.35); outline:1px solid color-mix(in srgb, #000 22%, transparent); z-index:1; pointer-events:none; }
.office-lamp { position:absolute; top:24px; right:10px; width:18px; height:30px; display:flex; flex-direction:column; align-items:center; z-index:2; pointer-events:none; }
.office-lamp-shade { width:16px; height:9px; background:linear-gradient(180deg, #b56a24, #e29a3a); clip-path:polygon(18% 0, 82% 0, 100% 100%, 0 100%); border-radius:1px; box-shadow:0 5px 10px 2px color-mix(in srgb, #ffb14a 50%, transparent); position:relative; }
.office-lamp-shade:after { content:""; position:absolute; left:2px; right:2px; bottom:-1px; height:3px; background:#ffe7b0; opacity:.8; filter:blur(1px); }
.office-lamp-stem { width:2px; height:14px; margin-top:-1px; background:linear-gradient(180deg, #6a5644, #3d3228); }
.office-lamp-base { width:9px; height:3px; margin-top:-1px; border-radius:2px 2px 1px 1px; background:#4a3b2e; box-shadow:0 1px 0 #2a2118; }
.office-monitor { position:relative; z-index:2; display:flex; flex-direction:column; align-items:center; width:62px; margin-top:2px; pointer-events:none; }
.office-monitor-head { position:relative; width:58px; height:40px; padding:5px 5px 8px; border-radius:5px 5px 3px 3px; background:linear-gradient(180deg, #55575d, #2c2e33); box-shadow: inset 0 1px 0 #7a7c82, 0 1px 0 #1a1b1e, 0 2px 4px color-mix(in srgb, #000 28%, transparent); }
.office-screen { width:100%; height:100%; border-radius:2px; background:#121316; box-shadow: inset 0 0 0 1px #0a0a0c; overflow:hidden; }
.office-screen.is-on { background:linear-gradient(180deg, color-mix(in srgb, var(--ui-accent) 70%, #1a1a22), #121316); animation:office-glow 1.1s ease-in-out infinite; }
.office-screen-copy { height:100%; overflow:hidden; padding:2px 3px 1px; font-size:5.5px; line-height:1.25; letter-spacing:0; color:#c9d4c4; text-align:left; word-break:break-word; }
.office-screen.is-on .office-screen-copy { color:#eef2ff; }
.office-monitor-cam { position:absolute; left:50%; bottom:2.5px; width:3px; height:3px; margin-left:-1.5px; border-radius:99px; background:#141416; box-shadow:0 0 0 1px #4a4c52; }
.office-monitor-neck { width:7px; height:7px; background:linear-gradient(180deg, #3e4046, #2a2c30); }
.office-monitor-base { width:24px; height:4px; border-radius:3px 3px 1px 1px; background:linear-gradient(180deg, #45474d, #2a2c30); box-shadow:0 1px 1px color-mix(in srgb, #000 30%, transparent); }
.office-seat { position:relative; width:42px; height:46px; margin-top:-8px; z-index:3; }
.office-desk-chair { position:absolute; left:0; top:0; display:block; transform-origin:50% 90%; filter:drop-shadow(0 2px 2px rgba(0,0,0,.3)); }
.office-desk-chair.is-wobble { animation:office-wobble .5s ease-in-out 2; }
.office-stage .office-person { position:absolute; left:0; top:-2px; margin:0; z-index:3; width:42px; }
.office-stage .office-person .office-status { position:absolute; top:100%; left:50%; transform:translateX(-50%); margin-top:2px; }
.office-stage .office-person .office-hearts { left:50%; transform:translateX(-50%); }
.office-person { position:relative; z-index:3; margin-top:4px; display:grid; justify-items:center; gap:4px; cursor:grab; touch-action:none; outline:none; }
.office-person.is-held { cursor:grabbing; z-index:30; }
.office-person.is-wander { position:absolute; margin:0; z-index:8; width:42px; will-change:left, top, transform; transform-origin:50% 100%; }
.office-person.is-wander .office-status { position:absolute; top:100%; left:50%; transform:translateX(-50%); margin-top:2px; }
.office-person.is-wander .office-hearts { left:50%; transform:translateX(-50%); }
.office-person.is-closer { transform: scale(1.12) translateY(4px); }
.office-eyes { transform: translate(calc(var(--edx, 0px) + var(--wdx, 0px)), var(--edy, 0px)); transition: transform .12s ease-out; }
.office-gaze { animation: office-gaze 10s ease-in-out infinite; }
.office-blink { transform-box: fill-box; transform-origin: center; animation: office-blink 4s ease-in-out infinite; }
.office-blink.is-double { animation-name: office-blink-double; }
.office-eye { transform-box: fill-box; transform-origin: center; }
.office-pupil, .office-lid { transition: cx .3s ease, cy .3s ease, rx .3s ease, ry .3s ease, opacity .3s ease; }
.office-face-think .office-eyes { animation: office-eyes-turn 0.9s ease-in-out infinite; }
.office-face-think .office-eye-l { animation: office-eye-far 0.9s ease-in-out infinite; }
.office-face-think .office-eye-r { animation: office-eye-near 0.9s ease-in-out infinite; }
.office-stage .office-person { animation: office-breathe 3.4s ease-in-out infinite; }
.office-stage .office-person.is-sleep { animation-duration: 5.6s; }
.office-stage .office-person.is-closer, .office-stage .office-person.is-held { animation: none; }
.office-ground { position:absolute; left:50%; bottom:-3px; width:30px; height:9px; margin-left:-15px; border-radius:50%; background: radial-gradient(ellipse at 50% 50%, rgba(0,0,0,.36), rgba(0,0,0,0) 70%); transform: scale(calc(1 - var(--lift, 0) * .5)); opacity: calc(1 - var(--lift, 0) * .55); z-index:-1; pointer-events:none; }
.office-person.is-drop .office-face { animation: office-drop .46s cubic-bezier(.2,.9,.3,1.2) 1; }
.office-puff-layer { position:absolute; inset:0; pointer-events:none; z-index:7; }
.office-puff { position:absolute; width:22px; height:10px; margin:-5px 0 0 -11px; border-radius:50%; border:2px solid rgba(255,255,255,.75); box-shadow: 0 0 0 1px rgba(0,0,0,.18), inset 0 0 0 1px rgba(0,0,0,.12); animation: office-puff .5s ease-out forwards; }
.office-puff:before, .office-puff:after { content:""; position:absolute; top:-2px; width:4px; height:4px; border-radius:99px; background:rgba(255,255,255,.85); box-shadow: 0 0 0 1px rgba(0,0,0,.18); animation: office-puff-dot .5s ease-out forwards; }
.office-puff:before { left:-4px; --dx:-8px; }
.office-puff:after { right:-4px; --dx:8px; }
.office-screen.is-boot { animation: office-boot .7s ease-out 1; }
.office-face { display:block; transform-origin:50% 80%; pointer-events:none; -webkit-user-drag:none; filter: drop-shadow(0 0 0.6px #fff) drop-shadow(0 0 0.8px #1a1a1a) drop-shadow(0 2px 3px rgba(0,0,0,.3)); }
.office-face-think { animation:office-think 0.9s ease-in-out infinite; }
.office-face-shy { animation:office-shy 0.16s ease-in-out infinite; }
.office-face-held { transform: rotate(16deg) scale(1.14); filter: drop-shadow(0 0 0.6px #fff) drop-shadow(0 0 0.8px #1a1a1a) drop-shadow(0 10px 8px color-mix(in srgb, #000 35%, transparent)); }
.office-face-sleep { transform: rotate(-18deg); }
.office-face-pet { animation:office-pet 0.45s ease-in-out infinite; }
.office-face-clap { animation:office-pet 0.28s ease-in-out infinite; }
.office-face-stretch { transform: scaleX(1.18) scaleY(0.9); }
.office-face-peek { transform: translateY(-6px); }
.office-status { font-size:10px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:var(--ui-accent); padding:1px 7px; border-radius:99px; white-space:nowrap; }
.office-status.is-idle { color:color-mix(in srgb, CanvasText 62%, transparent); }
.office-person.is-shy .office-status, .office-person.is-held .office-status { color:#f09; }
.office-whisper { position:absolute; top:-14px; right:-6px; font-size:12px; color:CanvasText; background:Canvas; border-radius:8px; padding:0 5px; box-shadow: 0 0 0 1px color-mix(in srgb, CanvasText 18%, transparent); }
.office-plate { position:relative; z-index:2; width:100%; padding:6px 8px 7px; border:0; border-radius:var(--office-radius); background:Canvas; color:CanvasText; text-align:center; cursor:pointer; box-shadow: var(--office-card-shadow); }
.office-plate:hover { box-shadow: 0 0 0 1px var(--ui-accent), 0 1px 0 rgba(0,0,0,.08), 0 5px 12px rgba(0,0,0,.16); }
.office-name { font-size:13px; font-weight:600; color:CanvasText; }
.office-handle { font-size:11px; color:color-mix(in srgb, CanvasText 60%, transparent); }
.office-say { position:relative; z-index:2; width:100%; margin-top:2px; padding:8px 10px 9px; border:0; border-radius:var(--office-radius); background:Canvas; color:CanvasText; font:inherit; font-size:12px; line-height:1.35; text-align:left; cursor:pointer; display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; box-shadow: var(--office-card-shadow); }
.office-say:before { content:""; position:absolute; left:50%; top:-5px; width:9px; height:9px; margin-left:-4.5px; background:Canvas; border-left:1px solid var(--ui-stroke-secondary); border-top:1px solid var(--ui-stroke-secondary); transform:rotate(45deg); }
.office-say:hover { outline-color:var(--ui-accent); }
.office-home { margin-top:2px; border:0; padding:2px 9px; border-radius:99px; color:color-mix(in srgb, CanvasText 72%, transparent); font:inherit; font-size:10px; cursor:pointer; }
.office-home:hover { color:var(--ui-accent); }
.office-desk.is-active .office-plate { box-shadow: 0 0 0 1.5px var(--ui-accent), 0 1px 0 rgba(0,0,0,.08), 0 5px 12px rgba(0,0,0,.16); }
.office-desk.is-think .office-desk-top { box-shadow:0 7px 0 #5a3d22, 0 8px 0 color-mix(in srgb, var(--ui-accent) 35%, transparent); }
.office-hearts { position:absolute; top:-10px; left:50%; display:flex; gap:4px; pointer-events:none; }
.office-hearts span { color:#f48; font-size:11px; animation:office-heart 0.9s ease-out forwards; }
.office-hearts span:nth-child(2) { animation-delay:.08s; }
.office-hearts span:nth-child(3) { animation-delay:.16s; }
.office-wander-layer { position:absolute; inset:0; pointer-events:none; z-index:8; }
.office-wander-layer .office-person { pointer-events:auto; }
.office-dot { opacity:.25; }
.office-dot-0 { animation:office-dot 1.1s ease-in-out infinite; }
.office-dot-1 { animation:office-dot 1.1s ease-in-out .18s infinite; }
.office-dot-2 { animation:office-dot 1.1s ease-in-out .36s infinite; }
@keyframes office-think { 0%,100% { transform: rotate(-10deg) translateY(0); } 50% { transform: rotate(11deg) translateY(-4px); } }
@keyframes office-shy { 0%,100% { transform: translateX(-3px) rotate(-12deg) scale(0.92); } 50% { transform: translateX(3px) rotate(10deg) scale(0.9); } }
@keyframes office-pet { 0%,100% { transform: rotate(-6deg) translateY(0); } 50% { transform: rotate(8deg) translateY(-5px); } }
@keyframes office-wobble { 0%,100% { transform: rotate(0); } 30% { transform: rotate(-8deg); } 70% { transform: rotate(8deg); } }
@keyframes office-heart { 0% { opacity:0; transform: translate(-50%, 6px) scale(.6); } 30% { opacity:1; } 100% { opacity:0; transform: translate(calc(-50% + 10px), -18px) scale(1); } }
@keyframes office-glow { 0%,100% { filter:brightness(1); } 50% { filter:brightness(1.35); } }
@keyframes office-dot { 0%,100% { opacity:.2; } 50% { opacity:1; } }
@keyframes office-plane { 0% { transform: translate(0, 0) rotate(var(--rot)) scale(.8); opacity:0; } 12% { opacity:1; } 100% { transform: translate(var(--dx), var(--dy)) rotate(var(--rot)) scale(.6); opacity:0; } }
@keyframes office-confetti { 0% { transform: translate(0, 0) rotate(0); opacity:1; } 60% { opacity:1; } 100% { transform: translate(calc(cos(var(--ang)) * 34px), calc(sin(var(--ang)) * 26px + 30px)) rotate(240deg); opacity:0; } }
@keyframes office-note { 0% { transform: translateY(6px) rotate(-8deg); opacity:0; } 25% { opacity:1; } 100% { transform: translateY(-26px) rotate(10deg); opacity:0; } }
@keyframes office-ding { 0% { transform: translate(-50%, 8px) scale(.6); opacity:0; } 20% { transform: translate(-50%, 0) scale(1.1); opacity:1; } 70% { opacity:1; } 100% { transform: translate(-50%, -6px); opacity:0; } }
@keyframes office-fly-a { 0% { transform: translate(0, 0); } 25% { transform: translate(120px, -30px); } 50% { transform: translate(60px, 60px); } 75% { transform: translate(-80px, 20px); } 100% { transform: translate(0, 0); } }
@keyframes office-fly-b { 0% { transform: translate(0, 0); } 30% { transform: translate(-90px, 40px); } 60% { transform: translate(40px, 80px); } 100% { transform: translate(0, 0); } }
@keyframes office-flap { from { transform: scaleX(1); } to { transform: scaleX(.35); } }
@keyframes office-flap-r { from { transform: scaleX(1); } to { transform: scaleX(.35); } }
@keyframes office-sweep { 0% { transform: translateX(-12%); } 100% { transform: translateX(12%); } }
@keyframes office-fire { from { transform: scaleY(.85) scaleX(.96); } to { transform: scaleY(1.08) scaleX(1.02); } }
@keyframes office-bubble { 0% { transform: translateY(0); opacity:.9; } 100% { transform: translateY(-11px); opacity:0; } }
@keyframes office-sway { 0%,100% { transform: rotate(-2.5deg); } 50% { transform: rotate(2.5deg); } }
@keyframes office-chew { 0%,100% { transform: scaleX(1) rotate(0); } 50% { transform: scaleX(1.06) rotate(-3deg); } }
@keyframes office-eom-hang { 0% { transform: rotate(-9deg) translateY(-6px); opacity:0; } 60% { transform: rotate(4deg); opacity:1; } 100% { transform: none; } }
@keyframes office-memo { 0% { transform: translateY(-10px) rotate(-12deg); opacity:0; } 100% { transform: none; opacity:1; } }
@keyframes office-quiet { to { opacity:0; } }
@keyframes office-hint { 0% { transform: translateY(8px) scale(.96); opacity:0; } 100% { transform: none; opacity:1; } }
@keyframes office-doodle { 0% { stroke-dashoffset:60; } 50% { stroke-dashoffset:0; } 100% { stroke-dashoffset:0; } }
@keyframes office-blink { 0%, 93%, 100% { transform: scaleY(1); } 95.5%, 96.5% { transform: scaleY(.08); } }
@keyframes office-blink-double { 0%, 88%, 92.5%, 100% { transform: scaleY(1); } 89.5%, 90.5% { transform: scaleY(.08); } 94%, 95% { transform: scaleY(.08); } 96.5% { transform: scaleY(1); } }
@keyframes office-gaze { 0%, 100% { transform: translate(0, 0); } 18% { transform: translate(.5px, -.2px); } 34% { transform: translate(-.4px, .2px); } 46% { transform: translate(-.4px, .2px); } 50% { transform: translate(2.2px, -.4px); } 58% { transform: translate(2.2px, -.4px); } 63% { transform: translate(0, 0); } 82% { transform: translate(-.6px, .3px); } }
@keyframes office-eyes-turn { 0%, 100% { transform: translate(calc(var(--edx, 0px) + var(--wdx, 0px) - 1.6px), var(--edy, 0px)); } 50% { transform: translate(calc(var(--edx, 0px) + var(--wdx, 0px) + 1.6px), calc(var(--edy, 0px) - .6px)); } }
@keyframes office-eye-far { 0%, 100% { transform: scaleX(.78); } 50% { transform: scaleX(1); } }
@keyframes office-eye-near { 0%, 100% { transform: scaleX(1); } 50% { transform: scaleX(.78); } }
@keyframes office-breathe { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1.2px); } }
@keyframes office-drop { 0% { transform: scale(1.22, .78); } 40% { transform: scale(.92, 1.08); } 70% { transform: scale(1.04, .97); } 100% { transform: scale(1, 1); } }
@keyframes office-puff { 0% { transform: scale(.4); opacity:.9; } 100% { transform: scale(1.5); opacity:0; } }
@keyframes office-puff-dot { 0% { transform: translate(0, 0); opacity:1; } 100% { transform: translate(var(--dx), -10px); opacity:0; } }
@keyframes office-boot { 0% { filter: brightness(3) contrast(1.4); } 30% { filter: brightness(.6); } 60% { filter: brightness(2); } 100% { filter: brightness(1); } }
@media (prefers-reduced-motion: reduce) {
  .office-stage .office-person, .office-blink, .office-gaze, .office-face-think .office-eyes, .office-face-think .office-eye-l, .office-face-think .office-eye-r, .office-face-think, .office-face-pet, .office-face-clap, .office-face-shy, .office-screen.is-on, .office-slice, .office-plant, .office-desk-chair.is-wobble, .office-person.is-drop .office-face, .office-butterfly, .office-wing, .office-sweep, .office-oven-fire, .office-bubble, .office-pendant, .office-person.has-pizza .office-face, .office-note, .office-doodle-line, .office-hint, .office-news, .office-confetti, .office-confetti i { animation: none !important; }
  .office-confetti { display:none !important; }
  .office-status.is-quiet { animation: none; opacity:.35; }
  .office-eom { animation: none; }
  .office-eyes { transition: none; }
  .office-pupil, .office-lid { transition: none; }
}
/* A warm miniature office. Controls stay on the desk rail; toys live on carpet. */
.office-root { --office-ink:#302d28; --office-paper:#faf5e9; --office-rust:#994830; --office-radius:7px; --office-card-shadow:0 2px 6px #241d2029; background:Canvas; color:CanvasText; }
.office-header { padding:18px 22px 14px; align-items:center; flex-wrap:wrap; }
.office-title { font-size:24px; font-weight:750; letter-spacing:-.035em; }
.office-head-right { flex-wrap:wrap; gap:10px; }
.office-tool { border-radius:5px; height:30px; font-size:12px; color:CanvasText; }
.office-room { margin:auto; width:min(calc(100% - 36px),1080px); box-sizing:border-box; flex:0 1 600px; max-height:100%; border-radius:10px; border-color:#756e5b; box-shadow:0 12px 30px #221b2038; min-height:300px; }
.office-stage-wrap { padding:16px 0; }
.office-grid { grid-template-columns:repeat(auto-fill,minmax(168px,1fr)); gap:20px; padding:20px 20px 28px; }
.office-window { right:8%; }
.office-desk { background:transparent; box-shadow:none; border-radius:0; }
.office-desk-top:before { content:''; position:absolute; left:12px; right:12px; height:26px; top:34px; border-left:5px solid #473d33; border-right:5px solid #473d33; }
.office-desk-top:after { content:''; position:absolute; left:28%; width:44%; top:8px; height:12px; background:repeating-linear-gradient(90deg,#b7b5a7 0 3px,#dedbce 3px 5px); border:3px solid #ccc9bd; border-radius:3px; transform:skewX(-8deg); }
.office-door { position:absolute; top:4px; left:48%; width:54px; height:78px; background:#a68058; border:5px solid #715738; border-bottom:0; box-shadow:inset 3px 0 6px #3c2b2640; z-index:2; }
.office-door span { position:absolute; left:4px; right:4px; top:17px; padding:4px 0; color:#eee0bb; background:#4e544e; text-align:center; font-size:8px; letter-spacing:.05em; }
.office-door i { position:absolute; right:7px; top:48px; width:5px; height:5px; border-radius:50%; background:#e1c37c; }
.office-room[data-incident=boss] .office-door { background:#423c32; border-left-width:11px; }
.office-noticeboard { position:absolute; top:9px; left:20%; width:89px; height:50px; border:5px solid #8d6742; background:#b48d5d; transform:rotate(-1deg); }
.office-noticeboard i,.office-noticeboard b { position:absolute; width:24px; height:27px; top:13px; left:9px; background:#f5e4a8; transform:rotate(-8deg); box-shadow:0 2px 2px #47332230; }
.office-noticeboard b { left:46px; background:#d9e4df; transform:rotate(6deg); }
.office-noticeboard span { display:block; font-size:7px; color:#382e20; text-align:center; margin-top:2px; font-weight:700; }
.office-eom { left:auto; right:24%; transform:none; }
.office-person > .office-face { position:relative; z-index:2; }
.office-person .office-status { margin-top:1px; }
.office-boss { position:absolute; width:42px; z-index:12; display:flex; flex-direction:column; align-items:center; pointer-events:none; }
.office-boss .office-face { position:relative; z-index:2; }
.office-boss-hair { position:absolute; top:2px; width:32px; height:9px; border-radius:9px 9px 2px 2px; background:#6b625a; z-index:3; }
.office-boss-glasses { position:absolute; left:9px; top:13px; width:10px; height:8px; border:2px solid #3b3935; border-radius:3px; z-index:4; box-shadow:12px 0 0 -2px #d5ae8c,12px 0 0 0 #3b3935; }
.office-clipboard { position:absolute; top:20px; right:-7px; width:16px; height:22px; background:#eed9aa; border:2px solid #856e47; border-radius:2px; transform:rotate(-12deg); z-index:4; }
.office-clipboard:after { content:''; position:absolute; left:3px; right:3px; top:5px; height:1px; background:#a69c7e; box-shadow:0 4px #a69c7e,0 8px #a69c7e; }
.office-boss-label { margin-top:5px; background:#3c4750; color:#fff5dc; padding:4px 7px; border-radius:3px; white-space:nowrap; font-size:10px; }
.office-coffee-rug { position:absolute; left:5%; top:15px; width:34%; bottom:24px; background:#bdab85; border:4px solid #d7c49f; border-radius:8px; box-shadow:0 2px 5px #22323730; transform:rotate(-1deg); }
.office-lounge-sofa { position:absolute; right:9%; top:0; width:105px; height:42px; border:9px solid #6c7770; border-bottom-width:13px; border-radius:12px 12px 5px 5px; background:#88948b; box-shadow:0 6px 0 -2px #493f35,0 9px 6px #23303b30; }
.office-lounge-sofa i,.office-lounge-sofa b { position:absolute; top:6px; left:5px; width:42px; height:22px; border-radius:5px; background:#9aa49a; border-bottom:3px solid #78847c; }
.office-lounge-sofa b { left:auto; right:5px; }
.office-furniture[data-office-prop=coffee]:before { content:''; position:absolute; width:65px; height:28px; top:32px; background:#ac885f; border-top:5px solid #e1cbaa; border-bottom:5px solid #725d48; border-radius:2px; }
.office-furniture[data-office-prop=coffee] .office-object { transform:translateY(-10px); }
.office-floor { padding-bottom:158px; }
.office-plate { background:#f5eddb; color:#38332a; border-radius:3px 3px 6px 6px; border-bottom:3px solid #b39b72; }
.office-name { font-weight:750; color:#38332a; }
.office-handle { color:#6b5d46; }
.office-say { font-size:11px; padding:8px; box-shadow:0 3px 7px #261f2526; }
.office-desk-top { border-radius:5px; }
.office-bar-sign { background:#994830; color:#fff8e6; border-radius:3px; padding:6px 12px; letter-spacing:.08em; transform:rotate(-3deg); }
.office-bar-counter { justify-content:center; padding:0; background:#d8bea0; box-shadow:0 6px 0 #8c6545,0 12px 9px #251b2633; }
.office-bar-shelf { background:#c9a781; box-shadow:inset 0 1px 0 #ecd6ba; }
.office-taskbar { padding:12px 20px; border-top:1px solid var(--ui-stroke-secondary); }
.office-task-input { border-radius:5px; min-height:36px; caret-color:var(--ui-accent); }
.office-root :focus-visible { outline:2px solid var(--ui-accent,#994830); outline-offset:3px; }
.office-root ::selection { background:#e5b67b; color:#302d28; }
.office-root { scrollbar-color:#9b8b71 transparent; scrollbar-width:thin; }
.office-clock-lcd,.office-paper-date { font-variant-numeric:tabular-nums; }
.office-life { position:relative; flex-shrink:0; color:CanvasText; z-index:20; }
.office-life-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:7px; padding:12px 20px; }
.office-life-caption { font-size:11px; color:var(--ui-text-secondary); margin-right:auto; }
.office-life-button,.office-panel-close { border:1px solid var(--ui-stroke-secondary,#c7bca9); border-radius:5px; padding:6px 10px; background:Canvas; color:CanvasText; font:inherit; font-size:12px; cursor:pointer; }
.office-life-button:hover,.office-panel-close:hover { background:color-mix(in srgb,CanvasText 7%,Canvas); }
.office-life-button[aria-expanded=true],.office-life-button[aria-pressed=true] { background:#994830; border-color:#994830; color:#fff8ee; }
.office-life-button:disabled { opacity:.5; cursor:default; }
.office-chaos { display:flex; gap:6px; align-items:center; font-size:11px; }
.office-life select { background:Canvas; color:CanvasText; border:1px solid var(--ui-stroke-secondary,#c7bca9); border-radius:4px; padding:5px; font:inherit; }
.office-life-panel { position:absolute; bottom:100%; right:18px; width:min(440px,calc(100vw - 60px)); max-height:min(420px,60vh); overflow:auto; padding:22px; background:Canvas; color:CanvasText; border:1px solid var(--ui-stroke-secondary,#c7bca9); border-radius:9px; box-shadow:0 12px 32px #15101140; }
.office-life-panel h2 { margin:0 45px 8px 0; font-size:19px; line-height:1.2; letter-spacing:-.025em; }
.office-life-panel p { margin:8px 0 16px; font-size:12px; line-height:1.6; }
.office-panel-close { float:right; font-size:11px; }
.office-toy-list,.office-furniture-list { display:flex; flex-wrap:wrap; gap:8px; }
.office-personality-row { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px; font-size:13px; }
.office-personality-row span { overflow-wrap:anywhere; min-width:0; }
.office-personality-row select { max-width:65%; }
.office-incident-caption { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin:0 20px 10px; padding:10px 12px; background:var(--office-paper); color:var(--office-ink); border-radius:5px; font-size:12px; }
.office-incident-caption strong { font-size:12px; }
.office-incident-caption span { flex:1; min-width:160px; }
.office-newspaper { background:var(--office-paper); color:var(--office-ink); padding:18px; margin-top:30px; }
.office-newspaper h2 { font-family:Georgia,serif; font-size:30px; margin-right:0; border-bottom:3px double #8c8068; padding-bottom:12px; }
.office-newspaper ol { list-style:none; padding:0; margin:0; }
.office-newspaper li { border-top:1px solid #d7cdb8; }
.office-newspaper li button { text-align:left; padding:10px 0; border:0; background:transparent; color:inherit; cursor:pointer; font:inherit; font-size:12px; line-height:1.5; }
.office-newspaper time { font-size:10px; color:#6c604c; }
.office-memory { border-top:2px solid #8c8068; padding-top:12px; }
.office-memory-scene { position:relative; height:140px; overflow:hidden; background:#587e8f; border-radius:4px; margin-bottom:12px; }
.office-memory-scene .office-object { transform:scale(.65); }
.office-life-scene { position:absolute; inset:auto 0 0; height:150px; pointer-events:none; z-index:6; }
.office-furniture { position:absolute; width:66px; height:60px; transform:translate(-50%,-50%); padding:0; border:0; background:transparent; color:#fff9e9; cursor:pointer; pointer-events:auto; touch-action:none; display:flex; flex-direction:column; align-items:center; justify-content:center; }
.office-furniture-label { position:absolute; top:100%; padding:3px 5px; background:#302d28; border-radius:3px; font-size:10px; white-space:nowrap; opacity:0; transition:opacity .15s; }
.office-furniture:hover .office-furniture-label,.office-furniture:focus-visible .office-furniture-label,.is-arranging .office-furniture-label { opacity:1; }
.is-arranging .office-furniture { outline:1px dashed #ffefd3; outline-offset:5px; cursor:move; }
.office-floor-plaque { position:absolute; bottom:13px; left:50%; transform:translateX(-50%); color:#fff8e8; opacity:.8; font-size:10px; white-space:nowrap; }
.office-object { width:42px; height:42px; position:relative; display:inline-block; filter:drop-shadow(0 4px 2px #16232d50); }
.art-mug { width:25px; height:25px; margin-top:15px; background:#e9d5ae; border-radius:2px 2px 8px 8px; border-top:3px solid #70492f; }
.art-mug i { right:-8px; top:2px; width:12px; height:14px; border:4px solid #e9d5ae; border-radius:5px; }
.art-parcel { width:25px; height:20px; background:#c9a16c; border-top:5px solid #dfbc8c; border-bottom:3px solid #9d7547; border-radius:2px; }
.art-parcel i { left:10px; top:-5px; width:5px; height:22px; background:#f0dbb4; }
.office-input-request { padding:7px 9px; border:1px solid #a65d36; background:#fff0cc; color:#5d3823; font:inherit; font-size:11px; border-radius:4px; cursor:pointer; }
.office-person.is-waiting:after { content:''; position:absolute; right:-6px; top:-8px; width:8px; height:26px; border-radius:6px; background:#e8ba80; transform:rotate(18deg); box-shadow:0 2px 3px #332b2430; }
.office-person.is-waiting .office-face { animation:none; }
.office-person.is-waiting .office-status { color:#fff5dc; background:#754127; }
.office-object i,.office-object b,.office-object em,.office-object small { position:absolute; display:block; box-sizing:border-box; }
.art-coffee { width:34px; height:42px; background:#dbc8aa; border-radius:5px 5px 2px 2px; border-bottom:5px solid #655746; }
.art-coffee i { top:6px; left:5px; width:24px; height:10px; background:#3c4844; border-radius:2px; }
.art-coffee b { top:16px; left:6px; width:22px; height:18px; background:#4e4035; }
.art-coffee em { top:23px; left:11px; width:12px; height:11px; border-radius:1px 1px 5px 5px; background:#fff3d1; }
.art-coffee small { top:24px; left:21px; width:6px; height:7px; border:2px solid #fff3d1; border-radius:3px; }
.art-fan i { top:0; left:5px; width:32px; height:32px; border:3px solid #ded8bc; border-radius:50%; background:#638e8a; }
.art-fan b { top:7px; left:12px; width:18px; height:18px; border:6px dotted #ede5ce; border-radius:50%; animation:office-fan-spin 2s linear infinite; }
.art-fan em { left:18px; top:31px; width:6px; height:9px; background:#c9b993; }
.art-fan small { top:38px; left:8px; width:27px; height:5px; border-radius:3px; background:#ede5ce; }
.art-chair i { top:0; left:7px; width:28px; height:25px; border-radius:7px; background:#b56e45; border:3px solid #8f5137; }
.art-chair b { top:23px; left:3px; width:36px; height:10px; background:#cb8656; border-radius:4px; }
.art-chair em { top:32px; left:19px; width:4px; height:8px; background:#d6d4c8; }
.art-chair small { top:39px; left:7px; width:28px; height:4px; background:#302d28; border-radius:3px; }
.art-bin { width:28px; height:32px; margin-top:8px; border:3px solid #d7d3bb; border-radius:2px 2px 7px 7px; background:repeating-linear-gradient(90deg,#788b84 0 3px,#a4ada0 3px 5px); }
.art-bin i,.art-bin b { width:14px; height:16px; top:-8px; left:2px; background:#fff0d1; transform:rotate(-18deg); }
.art-bin b { left:11px; top:-5px; transform:rotate(16deg); }
.art-cat { height:26px; width:44px; margin-top:16px; background:#dfa969; border-radius:45% 50% 40% 40%; }
.art-cat i { width:22px; height:21px; left:0; top:-7px; background:#e4b276; border-radius:5px 5px 40% 40%; }
.art-cat i:before,.art-cat i:after { content:''; position:absolute; top:-7px; border-bottom:10px solid #e4b276; border-left:5px solid transparent; border-right:5px solid transparent; }
.art-cat i:after { right:0; }
.art-cat b { left:5px; top:1px; width:4px; height:2px; background:#4b3929; box-shadow:8px 0 #4b3929; }
.art-cat em { right:-8px; top:5px; width:20px; height:18px; border:5px solid #b78046; border-radius:50%; border-left-color:transparent; }
.art-certificate { width:34px; height:40px; border:4px solid #986e3d; background:#fff0ce; transform:rotate(-5deg); }
.art-certificate i { top:8px; left:6px; width:14px; height:2px; background:#aa936d; box-shadow:0 5px #aa936d,0 10px #aa936d; }
.art-certificate b { bottom:3px; right:4px; width:8px; height:8px; border-radius:50%; background:#a6513b; }
.art-aquarium { width:52px; height:35px; background:#81bdc5; border:3px solid #d8ccae; border-bottom:6px solid #b2915f; border-radius:4px; }
.art-aquarium i { left:10px; top:10px; width:13px; height:8px; border-radius:50%; background:#eeab57; animation:office-fish 4s ease-in-out infinite alternate; }
.art-aquarium b { right:6px; bottom:0; width:8px; height:20px; border-radius:80% 0; background:#518578; }
.art-button { width:35px; height:24px; margin-top:18px; background:#5c5d55; border-radius:5px; }
.art-button i { top:-8px; left:6px; width:23px; height:23px; border-radius:50%; background:#b53e31; border-bottom:5px solid #772d27; }
.art-pizza-box { width:43px; height:32px; background:#d7b681; border:3px solid #997849; border-radius:3px; transform:rotate(-8deg); }
.art-pizza-box i { top:4px; left:9px; width:18px; height:18px; border-radius:50%; background:#e7ab50; border:3px solid #b55936; }
.office-keepsakes { position:absolute; left:3px; top:50px; display:flex; gap:0; z-index:2; pointer-events:none; }
.office-keepsakes .office-object { transform:scale(.35); transform-origin:bottom left; margin-right:-25px; }
.office-keepsakes .art-mug { margin-right:-13px; }
.office-root[data-office-hidden=true] * { animation-play-state:paused !important; }
.office-banter { position:absolute; bottom:calc(100% + 10px); left:50%; transform:translateX(-50%) rotate(-2deg); max-width:150px; min-width:95px; background:#fff7df; color:#423622; border-radius:7px 7px 7px 0; box-shadow:0 3px 7px #18252d30; padding:7px 9px; font-size:11px; line-height:1.35; z-index:10; pointer-events:none; }
.quirk-quiet.is-cheers .office-face { animation:none; transform:rotate(-5deg); }
.quirk-champion.is-cheers .office-face { animation:office-victory .6s ease-in-out infinite; }
.quirk-tidy.is-wander .office-face { transform:rotate(0); }
.quirk-curious.is-wander .office-face { transform:rotate(7deg); }
.office-incident-art { position:absolute; left:40%; top:58%; width:160px; height:80px; }
.office-visiting-object { display:block; position:absolute; width:36px; height:36px; animation:office-toy-travel 4s ease-in-out infinite alternate; }
.incident-ball .office-visiting-object { border-radius:50%; background:conic-gradient(#e5bc60 0 90deg,#e8e4ca 90deg 180deg,#ba6345 180deg 270deg,#5b9294 270deg); box-shadow:0 4px 7px #172b3440; }
.incident-mouse .office-visiting-object { width:27px; height:17px; background:#d2c9b8; border-radius:70% 50% 50% 70%; border-right:7px solid #a4937e; }
.incident-mouse .office-visiting-object:after { content:''; position:absolute; right:-25px; top:9px; width:20px; height:9px; border-top:2px solid #e0baaf; border-radius:50%; }
.incident-ufo .office-visiting-object { width:55px; height:19px; border-radius:50%; background:#b9c9b3; border-bottom:5px solid #6d8f82; top:-80px; }
.incident-ufo .office-visiting-object:before { content:''; position:absolute; left:16px; top:-13px; width:25px; height:18px; background:#a6d9ce; border-radius:50% 50% 0 0; }
.incident-delivery .office-visiting-object { width:50px; height:70px; background:#6e9566; border-radius:70% 15% 60% 20%; border-bottom:25px solid #bc825d; animation:office-plant-arrives 4s ease-out forwards; }
.incident-printer .office-incident-art i { position:absolute; width:22px; height:28px; background:#fff1d8; border-top:5px solid #cfbda0; animation:office-paper-storm 3s ease-out infinite; animation-delay:calc(var(--n) * -.5s); }
.incident-printer .office-visiting-object { width:46px; height:28px; background:#dfd8c3; border-top:7px solid #766f60; border-bottom:5px solid #a59b85; border-radius:4px; animation:none; }
.incident-printer.phase-1 .art-chair,.incident-mouse.phase-1 .art-cat { animation:office-toy-travel 3s ease-in-out infinite alternate; }
.incident-ball.phase-1 .art-fan b,.incident-printer.phase-1 .art-fan b { animation-duration:.25s; }
.office-room[data-incident=gravity] .office-person:not(.is-think) .office-face,.incident-gravity .office-object { animation:office-zero-g 4s ease-in-out infinite alternate; }
.office-room[data-incident=ice] .office-wander-layer .office-person:not(.is-think) .office-face,.incident-ice .art-chair { animation:office-skate 3s ease-in-out infinite alternate; }
.office-room[data-incident=ufo] .office-eom { animation:office-zero-g 4s ease-in-out infinite alternate; }
@keyframes office-fan-spin { to { transform:rotate(360deg); } }
@keyframes office-fish { to { transform:translateX(15px); } }
@keyframes office-victory { 50% { transform:translateY(-12px) rotate(12deg); } }
@keyframes office-toy-travel { from { transform:translate(-65px,20px) rotate(-15deg); } to { transform:translate(100px,-25px) rotate(20deg); } }
@keyframes office-paper-storm { from { transform:translate(0,0) rotate(-20deg); opacity:1; } to { transform:translate(calc(var(--n) * 35px - 70px),-90px) rotate(100deg); opacity:0; } }
@keyframes office-plant-arrives { from { transform:scale(.4); } to { transform:scale(1.5) translateY(-20px); } }
@keyframes office-zero-g { to { transform:translateY(-28px) rotate(12deg); } }
@keyframes office-skate { to { transform:translateX(25px) rotate(-15deg); } }
@media (max-width:700px) { .office-header { padding:12px; gap:8px; } .office-room { margin:0 8px; } .office-title { font-size:20px; } .office-life-caption { display:none; } .office-life-toolbar { padding:8px 12px; } .office-chaos { width:100%; } .office-life-panel { right:8px; padding:16px; width:calc(100vw - 52px); } .office-recap { display:none; } }
@media (prefers-reduced-motion:reduce) { .office-life-scene *, .office-keepsakes *, .office-memory-scene *, .office-room[data-incident] .office-face, .office-room[data-incident] .office-eom, .quirk-champion.is-cheers .office-face { animation:none !important; transition:none !important; } }
`
  let style = document.getElementById('amm-opc-office-css')

  if (!style) {
    style = document.createElement('style')
    style.id = 'amm-opc-office-css'
    document.head.appendChild(style)
  }

  style.textContent = css
}

const plugin = {
  id: ID,
  name: 'AMM OPC OS',
  register(ctx) {
    pluginCtx = ctx
    injectOfficeCss()
    injectOsShellCss()
    injectDeskCss()
    loadOsRooms(ctx)
    importBootstrapRoom()

    try {
      const seats = ctx.storage?.get?.('seats', null)
      if (seats && typeof seats === 'object' && !Array.isArray(seats)) $seats.set(seats)
      const clock = ctx.storage?.get?.('clock', null)
      if (clock === 'digital' || clock === 'analog') $clockKind.set(clock)
      const clockPos = ctx.storage?.get?.('clockPos', null)
      if (clockPos && typeof clockPos.x === 'number' && typeof clockPos.y === 'number') $clockPos.set(clockPos)
      const lastTask = ctx.storage?.get?.('lastTask', null)
      if (lastTask && typeof lastTask === 'object' && !Array.isArray(lastTask)) $lastTask.set(lastTask)
      const month = ctx.storage?.get?.('month', null)
      if (month && typeof month === 'object' && typeof month.start === 'number') $month.set(month)
      const week = ctx.storage?.get?.('week', null)
      if (week && typeof week === 'object' && typeof week.start === 'number') $week.set(week)
      const hintStage = ctx.storage?.get?.('hintStage', null)
      $hint.set(hintStage === 'wait' || hintStage === 'play' || hintStage === 'done' ? hintStage : 'task')
      const news = ctx.storage?.get?.('news', null)
      if (news && typeof news === 'object' && !Array.isArray(news)) $news.set(news)
      const ritualHour = ctx.storage?.get?.('ritualHour', null)
      if (typeof ritualHour === 'number') $ritual.set({ hour: ritualHour, at: 0 })
      const trophies = ctx.storage?.get?.('trophies', null)
      if (trophies && typeof trophies === 'object' && !Array.isArray(trophies)) $trophies.set(trophies)
      $backdrop.set('carpet')
      $officeLife.set(normalizeOfficeLife(ctx.storage?.get?.('officeLife', null)))
      const jobs = normalizeJobs(ctx.storage?.get?.(JOBS_STORAGE_KEY, null))
      $jobs.set(jobs)
      for (const row of Object.values(jobs)) {
        jobSequence = Math.max(jobSequence, Number(row.generation) || 0)
      }
    } catch {
      /* no storage */
    }

    let stopEvents = null
    let stopOsEvents = null
    try {
      if (typeof host.onEvent === 'function') { stopEvents = host.onEvent('*', handleJobEvent); stopOsEvents = host.onEvent('*', osHandleGatewayEvent) }
    } catch {
      /* older shell */
    }
    try {
      ctx.onDispose?.(() => {
        stopEvents?.()
        stopEvents = null
        stopOsEvents?.()
        stopOsEvents = null
        // Stop transport work without deleting persisted records. A plugin
        // unload/reload must leave accepted tasks recoverable.
        for (const { timer } of jobPollers.values()) clearInterval(timer)
        jobPollers.clear()
        stopMusicalChairs()
        pluginCtx = null
      })
    } catch {
      /* older shell */
    }

    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/office' },
      render: () => jsx(OsShell, {})
    })

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/office', label: 'AMM OPC OS', codicon: 'organization' }
    })

    ctx.register({
      id: 'palette',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.open`,
        label: '打开 AMM OPC OS',
        keywords: ['机器人', '工位', '楼层', '办公室', '吧台', '跳房子', 'desk', '指挥台', '悬决', '台账'],
        run: () => host.navigate('/office')
      }
    })

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 140,
      render: () => jsx(OfficeChip, {})
    })
  }
}

export default plugin

export const __test = {
  DeskHome, PendingPanel, TaskPanel,
  $osRooms, getRoom, createOsRoom, appendOsLog, parseOsMentions, isOsPass, osNewMessages, buildOsTurnPrompt, archiveOsDeliberation, runOsRounds, stopOsRounds, osConcludeToProposal, osStartRoomFromProposal, loadOsRooms, sendOsUserMessage, OsGroupChat, renameOsRoom, addOsRoomMembers, deleteOsRoom, osGrillStart, osGrillSubmit, osGrillBrief, osGrillClose, $grill, ensureOsSession, osMemberSpeak, buildOsTurnPrompt, archiveOsDeliberation, osAssistOnChange, osAssistOnKey, osAssistPick, osAssistClose, $assist, $osAttach, OS_SLASH_COMMANDS,
  $osActiveRoom, osRegisterConclusion, osDispatchToCeo, osFindRoomBySource, osSortMembers, stripOsTitlePrefix, $deckTab,
  $matterFocus, MatterFocusPanel, matterChain, nextAction, goFocusMatter, osDeliverAndAwait, osAwaitReceipt, osNudgeDispatch,
  importBootstrapRoom, OS_DIRECTED_TIMEOUT_MS, OS_TURN_TIMEOUT_MS, osHydrateRoomMarks,
 AcceptancePanel, CommitmentPanel, FinancePanel, OpsPanel, SearchPanel, ProposalDrawer, EscalationDrawer, CommitmentDrawer, KanbanDetailDrawer, AcceptanceDrawer, RulingsCard, ReconDrawer,
  deskMood,
  displayName,
  botHandle,
  previewLine,
  faceMood,
  movedEnough,
  near,
  isNightHour,
  stickyText,
  clockLabel,
  clockHands,
  nextClockKind,
  pickBotChatRow,
  resolvePicked,
  roamMs,
  easeInOut,
  backdropNames,
  nextBackdrop,
  idleBotNames,
  chairCountForGame,
  pickFreeStool,
  nextBarStand,
  placeChairs,
  assignChairs,
  beginWalk,
  advanceWalk,
  walkHop,
  completionToken,
  taskTransition,
  normalizeJobs,
  jobIsActive,
  jobAllowsSubmission,
  pickBotRoute
}
