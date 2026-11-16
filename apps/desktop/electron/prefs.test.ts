import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTIFY_DEFAULTS } from '../shared/notify-prefs.ts'
import { PET_PREFS_DEFAULTS, type PetPrefs } from '../shared/pet.ts'
import { heraldOsDataDir } from './paths.ts'
import { adoptLegacyNotify, readPrefs, writePrefs } from './prefs.ts'

const saved = process.env.HERMES_HOME
let root = ''
const hostPlatform = process.platform
const file = () => process.platform === 'win32' ? path.join(root, 'appdata', 'Herald OS', 'prefs.json') : path.join(root, 'herald-os', 'prefs.json')
const onDisk = () => JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, unknown>

function store(prefs: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(prefs))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-prefs-'))
  process.env.HERMES_HOME = root
  vi.stubEnv('APPDATA', path.join(root, 'appdata'))
  expect(heraldOsDataDir()).toBe(path.join(root, 'herald-os'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  if (saved === undefined) {
    delete process.env.HERMES_HOME
  } else {
    process.env.HERMES_HOME = saved
  }

  fs.rmSync(root, { recursive: true, force: true })
})

describe('the name on comments in the prefs', () => {
  it('reads it as one line with single spaces, cut to 80 characters, and leaves out one that is empty or not text', () => {
    store({ commentName: '  Sam \n  Rivera  ' })
    expect(readPrefs().commentName).toBe('Sam Rivera')

    store({ commentName: 'x'.repeat(200) })
    expect(readPrefs().commentName).toHaveLength(80)

    store({ commentName: '   ' })
    expect(readPrefs().commentName).toBeUndefined()

    store({ commentName: 42 })
    expect(readPrefs().commentName).toBeUndefined()

    store({ theme: 'graphite' })
    expect(readPrefs().commentName).toBeUndefined()
  })

  it('writes it the same way, keeps it through other changes, and clears it with an empty one', () => {
    expect(writePrefs({ commentName: ' Sam   Rivera ' }).commentName).toBe('Sam Rivera')
    expect(onDisk().commentName).toBe('Sam Rivera')

    writePrefs({ theme: 'graphite' })
    expect(onDisk()).toMatchObject({ commentName: 'Sam Rivera', theme: 'graphite' })

    expect(writePrefs({ commentName: '' }).commentName).toBeUndefined()
    expect(onDisk()).not.toHaveProperty('commentName')
    expect(readPrefs().commentName).toBeUndefined()
  })
})

describe('native operational voice session reference', () => {
  it('persists only the native id through unrelated voice changes and a fresh disk read', () => {
    store({ theme: 'graphite' })
    expect(readPrefs().operationalVoiceSessionId).toBeUndefined()
    writePrefs({ operationalVoiceSessionId: 'native-stored-voice-id' })
    writePrefs({ voice: { ...readPrefs().voice, followUpSeconds: 12 } })
    expect(readPrefs().operationalVoiceSessionId).toBe('native-stored-voice-id')
    expect(onDisk()).toMatchObject({ operationalVoiceSessionId: 'native-stored-voice-id', theme: 'graphite' })
    expect(onDisk()).not.toHaveProperty('voiceHistory')
  })

  it.each([42, '', '   ', 'x'.repeat(513)])('drops an invalid disk reference: %s', value => {
    store({ operationalVoiceSessionId: value })
    expect(readPrefs().operationalVoiceSessionId).toBeUndefined()
  })

  it('trims native references on read and write, and clears invalid IPC values', () => {
    store({ operationalVoiceSessionId: '  native-from-disk  ' })
    expect(readPrefs().operationalVoiceSessionId).toBe('native-from-disk')
    expect(writePrefs({ operationalVoiceSessionId: '  native-from-ipc  ' }).operationalVoiceSessionId).toBe('native-from-ipc')
    expect(onDisk().operationalVoiceSessionId).toBe('native-from-ipc')
    expect(writePrefs({ operationalVoiceSessionId: 17 as never }).operationalVoiceSessionId).toBeUndefined()
    expect(onDisk()).not.toHaveProperty('operationalVoiceSessionId')
  })
})

describe('the language in the prefs', () => {
  it('persists German through unrelated edits and a fresh read', () => {
    store({ language: 'de-DE' })
    expect(readPrefs().language).toBe('de-DE')
    expect(writePrefs({ language: 'de-DE' }).language).toBe('de-DE')
    writePrefs({ theme: 'graphite' })
    expect(onDisk()).toMatchObject({ language: 'de-DE', theme: 'graphite' })
    expect(readPrefs().language).toBe('de-DE')
  })
  it('reads a language Herald has, or following the system, and leaves out anything else', () => {
    expect(readPrefs().language).toBeUndefined()

    store({ language: 'zh-CN' })
    expect(readPrefs().language).toBe('zh-CN')

    store({ language: 'system' })
    expect(readPrefs().language).toBe('system')

    store({ language: 'fr' })
    expect(readPrefs().language).toBeUndefined()
  })

  it('writes it the same way and keeps it through other changes', () => {
    expect(writePrefs({ language: 'zh-CN' }).language).toBe('zh-CN')
    writePrefs({ theme: 'graphite' })
    expect(onDisk()).toMatchObject({ language: 'zh-CN', theme: 'graphite' })

    expect(writePrefs({ language: 'zh' as never }).language).toBeUndefined()
    expect(onDisk()).not.toHaveProperty('language')
  })
})

describe('the pet in the prefs', () => {
  it('reads the defaults when there is nothing stored, or no prefs file at all', () => {
    expect(readPrefs().pet).toEqual(PET_PREFS_DEFAULTS)

    store({ theme: 'graphite' })
    expect(readPrefs().pet).toEqual(PET_PREFS_DEFAULTS)
  })

  it('makes a stored one whole: unknown keys dropped, the spot held to the area, missing switches on', () => {
    store({ pet: { hidden: true, spot: { x: 1.4, y: 0.25 }, reactions: { running: false, dancing: false }, moods: 'none', colour: 'red' } })

    expect(readPrefs().pet).toEqual({
      ...PET_PREFS_DEFAULTS,
      hidden: true,
      spot: { x: 1, y: 0.25 },
      reactions: { ...PET_PREFS_DEFAULTS.reactions, running: false }
    })

    store({ pet: { hidden: 'yes', spot: { x: 0.5 }, followWindows: 0 } })
    expect(readPrefs().pet).toEqual(PET_PREFS_DEFAULTS)
  })

  it('writes whole sub-objects over what is stored and keeps them through other changes', () => {
    writePrefs({ pet: { ...PET_PREFS_DEFAULTS, spot: { x: 0.2, y: 0.9 } } })
    const quiet = { ...PET_PREFS_DEFAULTS, spot: { x: 0.2, y: 0.9 }, hidden: true, notes: { update: false, job: true } }

    expect(writePrefs({ pet: quiet }).pet).toEqual(quiet)
    writePrefs({ theme: 'graphite' })
    expect(onDisk()).toMatchObject({ theme: 'graphite', pet: quiet })

    expect(writePrefs({ pet: { hidden: false } as PetPrefs }).pet).toEqual({ ...quiet, hidden: false })
    expect(readPrefs().pet).toEqual({ ...quiet, hidden: false })
  })
})

describe('the Alerts switches in the prefs', () => {
  it('reads every switch on when there is no prefs file, nothing stored, or something malformed', () => {
    expect(readPrefs().notify).toEqual(NOTIFY_DEFAULTS)

    store({ theme: 'graphite' })
    expect(readPrefs().notify).toEqual(NOTIFY_DEFAULTS)

    store({ notify: { approvals: 'no', taskUpdates: false } })
    expect(readPrefs().notify).toEqual({ ...NOTIFY_DEFAULTS, taskUpdates: false })
  })

  it('merges a partial write over what is stored and keeps it through other changes', () => {
    writePrefs({ notify: { approvals: false } })
    expect(writePrefs({ notify: { nativeWhenUnfocused: false } }).notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, nativeWhenUnfocused: false })

    writePrefs({ theme: 'graphite' })
    expect(onDisk()).toMatchObject({ theme: 'graphite', notify: { approvals: false, nativeWhenUnfocused: false } })
    expect(readPrefs().notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, nativeWhenUnfocused: false })
  })

  it('keeps both switches when two windows each save a different one', () => {
    writePrefs({ notify: { approvals: false } })
    writePrefs({ notify: { taskUpdates: false } })
    writePrefs({ notify: { approvals: true } })

    expect(readPrefs().notify).toEqual({ ...NOTIFY_DEFAULTS, taskUpdates: false })
  })
})

describe('which Alerts switches prefs.json holds', () => {
  it('saves only the switches someone set, never the defaults, so other writes leave them unset', () => {
    writePrefs({ theme: 'graphite' })
    expect(onDisk().notify).toEqual({})

    writePrefs({ notify: { approvals: false } })
    writePrefs({ reduceMotion: true })
    expect(onDisk().notify).toEqual({ approvals: false })
    expect(readPrefs().notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false })
  })

  it('drops switch values that are not booleans, and keys that are not switches, from a write', () => {
    writePrefs({ notify: { approvals: 'false', taskUpdates: 0, toolCompletions: null, sound: false, nativeWhenUnfocused: false } as never })

    expect(onDisk().notify).toEqual({ nativeWhenUnfocused: false })
  })
})

describe('adopting Alerts switches from localStorage', () => {
  it('never lets an old localStorage value replace a switch prefs.json already has', () => {
    store({ notify: { approvals: false, taskUpdates: true } })

    const next = adoptLegacyNotify({ approvals: true, taskUpdates: false, nativeWhenUnfocused: false })

    expect(next.notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, taskUpdates: true, nativeWhenUnfocused: false })
    expect(onDisk().notify).toEqual({ approvals: false, taskUpdates: true, nativeWhenUnfocused: false })
  })

  it('fills every switch when prefs.json has none, or only malformed ones', () => {
    store({ theme: 'graphite', notify: { approvals: 'off' } })

    expect(adoptLegacyNotify({ toolCompletions: false, approvals: false }).notify).toEqual({ ...NOTIFY_DEFAULTS, toolCompletions: false, approvals: false })
    expect(onDisk()).toMatchObject({ theme: 'graphite' })
  })

  it('writes nothing when every switch offered is already saved, and ignores unknown keys', () => {
    store({ notify: { approvals: true } })
    const before = fs.readFileSync(file(), 'utf8')

    expect(adoptLegacyNotify({ approvals: false, sound: false }).notify).toEqual(NOTIFY_DEFAULTS)
    expect(fs.readFileSync(file(), 'utf8')).toBe(before)
  })

  it('ignores flags that are null, not an object, or an array, and writes nothing', () => {
    store({ notify: { approvals: false } })
    const before = fs.readFileSync(file(), 'utf8')

    for (const flags of [null, undefined, 'approvals', 42, true, [false, false]]) {
      expect(adoptLegacyNotify(flags).notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false })
    }

    expect(fs.readFileSync(file(), 'utf8')).toBe(before)
  })

  it('takes only keys that are switches of its own, not ones inherited from Object', () => {
    store({ notify: { approvals: true } })
    const before = fs.readFileSync(file(), 'utf8')

    expect(adoptLegacyNotify({ toString: false, constructor: false, hasOwnProperty: false }).notify).toEqual(NOTIFY_DEFAULTS)
    expect(fs.readFileSync(file(), 'utf8')).toBe(before)

    expect(adoptLegacyNotify(JSON.parse('{"__proto__": {"approvals": false}, "taskUpdates": false}')).notify).toEqual({ ...NOTIFY_DEFAULTS, taskUpdates: false })
  })

  it('still adopts a switch after an earlier prefs write, such as the theme at start-up', () => {
    writePrefs({ theme: 'graphite' })

    expect(adoptLegacyNotify({ approvals: false }).notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false })
    expect(onDisk()).toMatchObject({ theme: 'graphite', notify: { approvals: false } })
  })

  it('keeps what two windows with their own localStorage each bring, and the first value for a switch both had', () => {
    adoptLegacyNotify({ approvals: false })
    adoptLegacyNotify({ approvals: true, toolCompletions: false })

    expect(readPrefs().notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, toolCompletions: false })
  })

  it('rejects switch values that are not booleans', () => {
    writePrefs({ theme: 'graphite' })
    const before = fs.readFileSync(file(), 'utf8')

    expect(adoptLegacyNotify({ approvals: 'false', taskUpdates: 0, toolCompletions: null, nativeWhenUnfocused: {} }).notify).toEqual(NOTIFY_DEFAULTS)
    expect(fs.readFileSync(file(), 'utf8')).toBe(before)
  })

  it('does not count a corrupt prefs.json, or one holding null, as having every switch saved', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), '{"notify": {"approvals": fal')
    expect(adoptLegacyNotify({ approvals: false, taskUpdates: false }).notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, taskUpdates: false })

    fs.writeFileSync(file(), 'null')
    expect(adoptLegacyNotify({ toolCompletions: false }).notify).toEqual({ ...NOTIFY_DEFAULTS, toolCompletions: false })
    expect(onDisk().notify).toEqual({ toolCompletions: false })
  })
})

describe('standalone Windows client preferences', () => {
  it('persists German locally without reading or rewriting DRAGON and shared Hermes preferences', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const shared = path.join(root, 'herald-os', 'prefs.json')
    const dragon = path.join(root, 'appdata', 'DRAGON OS', 'prefs.json')
    for (const sentinel of [shared, dragon]) {
      fs.mkdirSync(path.dirname(sentinel), { recursive: true })
      fs.writeFileSync(sentinel, '{"language":"en","commentName":"protected"}')
    }
    expect(readPrefs().commentName).toBeUndefined()
    writePrefs({ language: 'de-DE', commentName: 'Herald test' })
    expect(readPrefs()).toMatchObject({ language: 'de-DE', commentName: 'Herald test' })
    expect(onDisk()).toMatchObject({ language: 'de-DE' })
    for (const sentinel of [shared, dragon]) expect(fs.readFileSync(sentinel, 'utf8')).toBe('{"language":"en","commentName":"protected"}')
  })
  it('uses native roaming AppData when APPDATA is missing', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('APPDATA', undefined)
    vi.spyOn(os, 'homedir').mockReturnValue(root)
    writePrefs({ language: 'de-DE' })
    expect(JSON.parse(fs.readFileSync(path.join(root, 'AppData', 'Roaming', 'Herald OS', 'prefs.json'), 'utf8'))).toMatchObject({ language: 'de-DE' })
  })
  it('keeps non-Windows client preference storage unchanged', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    writePrefs({ language: 'de-DE' })
    expect(JSON.parse(fs.readFileSync(path.join(root, 'herald-os', 'prefs.json'), 'utf8'))).toMatchObject({ language: 'de-DE' })
    expect(fs.existsSync(path.join(root, 'appdata', 'Herald OS', 'prefs.json'))).toBe(false)
  })
})
