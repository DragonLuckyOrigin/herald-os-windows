import { atom } from 'nanostores'
import type { PageId } from '../shell/apps.ts'
import { t } from './i18n.ts'

/*
 * The OS command registry: every user-visible thing the shell can do, as a named command with typed
 * arguments, a permission tier and a result the caller can speak or show. The command bar, the voice
 * fast path, the `herald-os` CLI / control socket and the agent's `os_ui` tool all call `runCommand`,
 * so a feature exists for voice the moment it registers here (DESIGN.md rule).
 */

export type CommandTier = 'read' | 'act' | 'mutate' | 'destructive'
export type CommandSource = 'voice' | 'agent' | 'palette' | 'cli' | 'shortcut' | 'ui' | 'follow' | 'plugin'

export interface CommandArg {
  name: string
  type: 'string' | 'number' | 'boolean'
  description: string
  required?: boolean
  /** Allowed values (case-insensitive); the first is the default when optional. */
  enum?: readonly string[]
  /** Other spoken words (lower case) for a value in `enum`, e.g. a German name; they never add a value. */
  aliases?: Readonly<Record<string, string>>
  /** Values for the `{slots}` of this argument's localized help, for lists the English text builds from code. */
  descriptionValues?: Readonly<Record<string, string | number>>
}

/** What the OS should draw attention to after a command: a page, a list item, a window. */
export interface CommandHighlight {
  kind: 'page' | 'memory' | 'automation' | 'mission' | 'file' | 'window' | 'connection' | 'setting'
  id: string
}

export interface CommandResult {
  ok: boolean
  /** One line for captions, the agent, and logs ("Opened Missions"). */
  summary: string
  /** Shorter/friendlier line to speak aloud when different from `summary`. */
  spoken?: string
  page?: PageId
  highlight?: CommandHighlight
  /** Structured data for the agent (list results, counts, ids). */
  items?: unknown[]
  data?: Record<string, unknown>
  error?: string
}

export interface CommandContext {
  source: CommandSource
  /** Set when one command delegates to another; nested runs are not logged (one caption per request). */
  nested?: boolean
}

/** An utterance pattern: `{arg}` marks a slot; an object form pins arguments the words imply ("turn off …"). */
export type CommandPhrase = string | { phrase: string; args: Record<string, unknown> }

export interface OsCommand {
  /** Dotted id, `area.verb`, the area all lowercase (e.g. `page.open`, `agents.pauseAll`); see `COMMAND_ID`. */
  id: string
  title: string
  description: string
  tier: CommandTier
  args: readonly CommandArg[]
  /** Example utterances for the voice matcher and the palette. */
  phrases?: readonly CommandPhrase[]
  /** The German utterances the matcher also accepts; Voice help shows these, and only these, in German. */
  phrasesDe?: readonly CommandPhrase[]
  /** Values for the `{slots}` of the localized description, for lists the English text builds from code. */
  descriptionValues?: Readonly<Record<string, string | number>>
  /** Not offered in the command bar (internal or needs context). */
  hidden?: boolean
  run: (args: Record<string, unknown>, context: CommandContext) => Promise<CommandResult> | CommandResult
}

export interface CommandSummary {
  id: string
  /** Title, description and argument help in the language shown now (`commands.catalog.<id>.*`), English where there is no entry. */
  title: string
  description: string
  tier: CommandTier
  args: readonly CommandArg[]
  /** Every phrase the matcher accepts: the English ones, then `phrasesDe`. */
  phrases: readonly CommandPhrase[]
  /** The German subset of `phrases`. */
  phrasesDe?: readonly CommandPhrase[]
  hidden: boolean
}

/** One executed command, for the action HUD and for debugging. */
export interface CommandEvent {
  id: number
  command: string
  args: Record<string, unknown>
  source: CommandSource
  result: CommandResult
  ts: number
}

const registry = new Map<string, OsCommand>()
let eventCounter = 0
const MAX_LOG = 50

/** Recent commands, newest first. The HUD shows those from voice, agent and follow. */
export const $commandLog = atom<CommandEvent[]>([])

/** A command id: a lowercase area, then camelCase words (`page.open`, `agents.pauseAll`, `voice.wake.set`). */
export const COMMAND_ID = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

/** Register commands; any whose id breaks `COMMAND_ID` is skipped and named in the error thrown after the rest are registered. */
export function defineCommands(commands: readonly OsCommand[]): void {
  const invalid: string[] = []

  for (const command of commands) {
    if (COMMAND_ID.test(command.id)) {
      registry.set(command.id, command)
    } else {
      invalid.push(command.id)
    }
  }

  if (invalid.length > 0) {
    throw new Error(`invalid command id${invalid.length > 1 ? 's' : ''} ${invalid.join(', ')} (a lowercase area, then camelCase words: page.open, agents.pauseAll)`)
  }
}

export function getCommand(id: string): OsCommand | undefined {
  return registry.get(id)
}

const translateLoose = t as unknown as (key: string, values?: Record<string, string | number>) => string

/** The catalog's text for a command's title, description or argument, or the English the command declares when the catalog has none. */
function localized(key: string, fallback: string, values?: Readonly<Record<string, string | number>>): string {
  const text = translateLoose(key, values ? { ...values } : undefined)

  return text === key ? fallback : text
}

const argHelp = (commandId: string, arg: CommandArg): string => localized(`commands.catalog.${commandId}.arg.${arg.name}`, arg.description, arg.descriptionValues)

/** Read time, not boot time: the language is whatever is shown when the list is asked for. */
function summarize(command: OsCommand): CommandSummary {
  const german = command.phrasesDe ?? []

  return {
    id: command.id,
    title: localized(`commands.catalog.${command.id}.title`, command.title),
    description: localized(`commands.catalog.${command.id}.description`, command.description, command.descriptionValues),
    tier: command.tier,
    args: command.args.map(arg => ({ ...arg, description: argHelp(command.id, arg) })),
    phrases: [...(command.phrases ?? []), ...german],
    phrasesDe: german,
    hidden: Boolean(command.hidden)
  }
}

export function listCommands(options: { includeHidden?: boolean } = {}): CommandSummary[] {
  return [...registry.values()]
    .filter(command => options.includeHidden || !command.hidden)
    .map(summarize)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * The phrases Voice help shows for a language: German shows the German ones only, any other language the
 * English ones. Both still run; the matcher takes `phrases`, which lists all of them.
 */
export function displayPhrases(command: Pick<CommandSummary, 'phrases'> & { phrasesDe?: readonly CommandPhrase[] }, language: string): readonly CommandPhrase[] {
  const german = command.phrasesDe ?? []

  if (language === 'de-DE') {
    return german
  }

  const split = command.phrases.length - german.length
  const endsWithGerman = german.length > 0 && split >= 0 && german.every((phrase, index) => command.phrases[split + index] === phrase)

  return endsWithGerman ? command.phrases.slice(0, split) : command.phrases
}

export const ok = (summary: string, extra: Omit<Partial<CommandResult>, 'ok' | 'summary'> = {}): CommandResult => ({ ok: true, summary, ...extra })
export const fail = (error: string, extra: Omit<Partial<CommandResult>, 'ok' | 'error'> = {}): CommandResult => ({ ok: false, summary: error, error, ...extra })

/** Coerce and validate arguments against the command's declaration; returns an error message or the clean args. */
export function validateArgs(command: Pick<OsCommand, 'id' | 'args'>, raw: Record<string, unknown> | undefined): { args: Record<string, unknown> } | { error: string } {
  const input = remapArgNames(command, raw ?? {})
  const clean: Record<string, unknown> = {}

  for (const spec of command.args) {
    let value = input[spec.name]

    if (value === undefined || value === null || value === '') {
      if (spec.required) {
        return { error: t('commands.validate.needs', { id: command.id, arg: spec.name, description: argHelp(command.id, spec) }) }
      }

      if (spec.enum?.length) {
        clean[spec.name] = spec.enum[0]
      }

      continue
    }

    if (spec.type === 'number') {
      const number = typeof value === 'number' ? value : Number(String(value).trim())

      if (!Number.isFinite(number)) {
        return { error: t('commands.validate.number', { id: command.id, arg: spec.name }) }
      }

      value = number
    } else if (spec.type === 'boolean') {
      value = typeof value === 'boolean' ? value : /^(true|yes|on|1)$/i.test(String(value).trim())
    } else {
      // Lists and objects (rows of cells, a format) travel as JSON, the way the command reads them.
      value = typeof value === 'object' ? JSON.stringify(value) : String(value).trim()
    }

    if (spec.enum) {
      const wanted = String(value).toLowerCase()
      const match = spec.enum.find(option => option.toLowerCase() === wanted) ?? spec.enum.find(option => option === spec.aliases?.[wanted])

      if (!match) {
        return { error: t('commands.validate.oneOf', { id: command.id, arg: spec.name, values: spec.enum.join(', ') }) }
      }

      value = match
    }

    clean[spec.name] = value
  }

  const unknown = Object.keys(input).filter(key => !command.args.some(spec => spec.name === key))

  if (unknown.length > 0) {
    return { error: t('commands.validate.unknownArg', { id: command.id, count: unknown.length, names: unknown.join(', ') }) }
  }

  return { args: clean }
}

/**
 * Callers (the agent especially) often guess an argument name: `page.open {page: "missions"}`
 * instead of `{name: …}`. When exactly one declared argument is missing and exactly one unknown key
 * was given, the unknown key fills it. Anything more ambiguous is left for validation to reject.
 */
export function remapArgNames(command: Pick<OsCommand, 'args'>, input: Record<string, unknown>): Record<string, unknown> {
  const declared = new Set(command.args.map(arg => arg.name))
  const unknown = Object.keys(input).filter(key => !declared.has(key))
  const missing = command.args.filter(arg => input[arg.name] === undefined)

  if (unknown.length !== 1) {
    return input
  }

  const target = missing.filter(arg => arg.required).length === 1 ? missing.find(arg => arg.required) : missing.length === 1 ? missing[0] : undefined

  if (!target) {
    return input
  }

  const { [unknown[0]]: value, ...rest } = input

  return { ...rest, [target.name]: value }
}

function record(command: string, args: Record<string, unknown>, source: CommandSource, result: CommandResult): void {
  const event: CommandEvent = { id: ++eventCounter, command, args, source, result, ts: Date.now() }
  $commandLog.set([event, ...$commandLog.get()].slice(0, MAX_LOG))
}

/** Run a command by id. Never throws: failures come back as `{ ok: false, error }` and are logged too. */
export async function runCommand(id: string, rawArgs: Record<string, unknown> | undefined, context: CommandContext): Promise<CommandResult> {
  const command = registry.get(id)

  if (!command) {
    const result = fail(t('commands.validate.unknownCommand', { id }))
    record(id, rawArgs ?? {}, context.source, result)

    return result
  }

  const validated = validateArgs(command, rawArgs)

  if ('error' in validated) {
    const result = fail(validated.error)
    record(id, rawArgs ?? {}, context.source, result)

    return result
  }

  let result: CommandResult

  try {
    result = await command.run(validated.args, context)
  } catch (error) {
    // ipcRenderer.invoke prefixes "Error invoking remote method '<channel>': Error: ".
    result = fail((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''))
  }

  if (!context.nested) {
    record(id, validated.args, context.source, result)
  }

  return result
}

/** Run another command from inside a command: same source, not logged separately. */
export function delegate(id: string, args: Record<string, unknown>, context: CommandContext): Promise<CommandResult> {
  return runCommand(id, args, { ...context, nested: true })
}

/** Test seam. */
export function resetCommands(): void {
  registry.clear()
  $commandLog.set([])
}
