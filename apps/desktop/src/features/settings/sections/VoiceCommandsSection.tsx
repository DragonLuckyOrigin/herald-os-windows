import type { TextKey } from '../../../../shared/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconMicrophone, IconPlayerPlay, IconRobot, IconShieldCheck } from '@tabler/icons-react'
import { useContext, useMemo } from 'react'
import { GlassButton, GlassCard, Pill } from '../../../components/ui/glass.tsx'
import { deviceNoun, voiceKeyLabel } from '../../../lib/platform-labels.ts'
import { $prefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { type CommandPhrase, type CommandSummary, displayPhrases, listCommands, runCommand } from '../../../store/os-commands.ts'
import { $language, t, useT } from '../../../store/i18n.ts'
import { SectionTitle, SettingsFilterContext } from './shared.tsx'

/*
 * Everything Herald OS can do by voice, generated from the command registry so it can never fall
 * behind the code. Grouped by area; each command shows what to say (slots in angle quotes), what it
 * does, whether it asks first, and a Try button for commands that need no details.
 */

interface Group {
  id: string
  title: TextKey
  prefixes: readonly string[]
}

const GROUPS: readonly Group[] = [
  { id: 'nav', title: "settings.detail.openAndNavigate.29305", prefixes: ['open', 'page', 'overlay', 'sidebar', 'space', 'help'] },
  { id: 'windows', title: "settings.detail.windows.d5980", prefixes: ['window'] },
  { id: 'typing', title: "settings.detail.typingAndEditing.ec5a9", prefixes: ['text', 'key', 'edit', 'view'] },
  { id: 'hermes', title: "settings.detail.hermesChatsAndMissions.4cc81", prefixes: ['chat', 'mission', 'agents'] },
  { id: 'build', title: "settings.detail.buildAndWatchStudio.2b492", prefixes: ['build', 'studio'] },
  { id: 'memory', title: "settings.detail.memory.c3963", prefixes: ['memory'] },
  { id: 'files', title: "settings.detail.files.abc7e", prefixes: ['files', 'file'] },
  { id: 'automations', title: "settings.detail.automations.ad1fb", prefixes: ['automation'] },
  { id: 'connections', title: "settings.detail.connections.dc273", prefixes: ['connection'] },
  { id: 'apps', title: "settings.detail.appsAndTheWeb.690fa", prefixes: ['native', 'web'] },
  { id: 'settings', title: "settings.detail.settingsAndAppearance.dca14", prefixes: ['settings', 'theme', 'accent', 'motion', 'dock', 'notifications'] },
  { id: 'voice', title: "settings.detail.voice.87bf2", prefixes: ['voice'] }
]

const SLOT_EXAMPLES: Record<string, string> = {
  name: 'missions',
  text: 'hello, how are you',
  query: 'my projects',
  goal: 'tidy my downloads',
  place: 'downloads',
  key: 'enter',
  match: 'tea',
  url: 'news.ycombinator.com',
  title: 'the Herald project',
  section: 'voice',
  theme: 'graphite',
  accent: 'violet',
  engine: 'live'
}

/** Examples that only make sense for one command ("create a website for a hair salon"). */
const COMMAND_SLOT_EXAMPLES: Record<string, string> = {
  'build.start.goal': 'a hair salon',
  'studio.preview.url': 'http://localhost:5173',
  'studio.file.path': 'index.html'
}

const phraseText = (phrase: CommandPhrase) => (typeof phrase === 'string' ? phrase : phrase.phrase)

function displayCommand(command: CommandSummary): CommandSummary {
  return { ...command, phrases: displayPhrases(command, $language.get()) }
}

const slotLabel = (name: string) => t(('commands.slot.' + name) as TextKey)

const GERMAN_SLOT_EXAMPLES: Record<string, string> = {
  ...SLOT_EXAMPLES, name: 'Missionen', text: 'Hallo, wie geht es dir', query: 'meine Projekte', goal: 'meine Downloads aufräumen', place: 'Downloads', key: 'Enter', match: 'Tee', title: 'das Herald-Projekt', section: 'Sprache'
}

const slotExamples = () => $language.get() === 'de-DE' ? GERMAN_SLOT_EXAMPLES : SLOT_EXAMPLES

/** "open {name}" -> parts for rendering the slot as a placeholder. */
function renderPhrase(phrase: string) {
  return phrase.split(/(\{[a-zA-Z]+\})/).map((part, index) => {
    const slot = /^\{([a-zA-Z]+)\}$/.exec(part)

    return slot ? (
      <span key={index} className="rounded bg-accent-soft px-1 text-accent-strong" title={t("settings.detail.eg.1a072", { value1: slotExamples()[slot[1]] ?? slotLabel(slot[1]) })}>
        {slotLabel(slot[1])}
      </span>
    ) : (
      <span key={index}>{part}</span>
    )
  })
}

function groupOf(command: CommandSummary): string {
  const prefix = command.id.split('.')[0]

  return GROUPS.find(group => group.prefixes.includes(prefix))?.id ?? 'hermes'
}

/** An example sentence with the slots filled in, for the section subtitle and tooltips. */
export function exampleFor(command: CommandSummary): string | null {
  const phrase = displayCommand(command).phrases.map(phraseText)[0]
  const examples = slotExamples()
  const specific: Record<string, string> = $language.get() === 'de-DE' ? { ...COMMAND_SLOT_EXAMPLES, 'build.start.goal': 'einen Friseursalon' } : COMMAND_SLOT_EXAMPLES

  return phrase ? phrase.replace(/\{([a-zA-Z]+)\}/g, (_match, slot: string) => specific[`${command.id}.${slot}`] ?? examples[slot] ?? slotLabel(slot)) : null
}

export function VoiceCommandsSection() {
  const t = useT()
  const query = useContext(SettingsFilterContext).trim().toLowerCase()
  const language = useStore($language)
  const commands = useMemo(() => listCommands({ includeHidden: true }).map(displayCommand), [language])
  const voiceKey = voiceKeyLabel(useStore($prefs).voice.hotkey)
  const matches = (command: CommandSummary) =>
    !query || command.title.toLowerCase().includes(query) || command.description.toLowerCase().includes(query) || command.id.includes(query) || command.phrases.some(p => phraseText(p).toLowerCase().includes(query))

  const spoken = commands.filter(command => command.phrases.length > 0 && matches(command))
  const agentOnly = commands.filter(command => command.phrases.length === 0 && matches(command))

  const tryCommand = async (command: CommandSummary) => {
    const result = await runCommand(command.id, {}, { source: 'palette' })

    if (!result.ok) {
      notify({ title: command.title, body: result.error ?? result.summary, level: 'warn' })
    }
  }

  return (
    <>
      <SectionTitle
        title={t('settings.section.commands')}
        subtitle={voiceKey ? t('settings.commands.subtitleKey', { count: commands.length, key: voiceKey }) : t('settings.commands.subtitle', { count: commands.length })}
      />

      <GlassCard className="settings-item flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-[12px] text-fg-2">
        <span className="flex items-center gap-1.5">
          <IconMicrophone size={14} className="text-accent-strong" /> {t('settings.voice.instant', { device: deviceNoun() })}</span>
        <span className="flex items-center gap-1.5">
          <IconShieldCheck size={14} className="text-warn" /> {t("settings.detail.asksFirstHermesShowsAnApprovalCard.4e0b7")}</span>
        <span className="flex items-center gap-1.5">
          <span className="rounded bg-accent-soft px-1 text-accent-strong">{t('settings.voice.slot')}</span> {t("settings.detail.sayYourOwnWordsThere.a8f51")}</span>
      </GlassCard>

      {GROUPS.map(group => {
        const items = spoken.filter(command => groupOf(command) === group.id)

        if (items.length === 0) {
          return null
        }

        return (
          <section key={group.id} className="settings-item flex flex-col gap-1.5">
            <h3 className="px-0.5 text-[12.5px] font-medium text-fg-2">{t(group.title)}</h3>
            <GlassCard className="flex flex-col divide-y divide-line">
              {items.map(command => (
                <CommandRow key={command.id} command={command} onTry={() => void tryCommand(command)} />
              ))}
            </GlassCard>
          </section>
        )
      })}

      {agentOnly.length > 0 && (
        <section className="settings-item flex flex-col gap-1.5">
          <h3 className="flex items-center gap-1.5 px-0.5 text-[12.5px] font-medium text-fg-2">
            <IconRobot size={14} /> {t("settings.detail.askHermesToDoThese.85747")}</h3>
          <GlassCard className="flex flex-col divide-y divide-line">
            {agentOnly.map(command => (
              <div key={command.id} className="flex items-start gap-3 px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-fg">{command.title}</div>
                  <div className="mt-0.5 text-[12px] leading-snug text-fg-3">{command.description}</div>
                </div>
                <code className="shrink-0 font-mono text-[11px] text-fg-4">{command.id}</code>
              </div>
            ))}
          </GlassCard>
        </section>
      )}

      {spoken.length === 0 && agentOnly.length === 0 && <div className="settings-item px-1 text-[12.5px] text-fg-3">{t('settings.commands.noMatch', { query })}</div>}
    </>
  )
}

function CommandRow({ command, onTry }: { command: CommandSummary; onTry: () => void }) {
  useT()
  const phrases = command.phrases.map(phraseText)
  const shown = phrases.slice(0, 4)
  const more = phrases.length - shown.length
  const canTry = !command.args.some(arg => arg.required) && command.tier !== 'destructive' && !/^(text|key|edit)\./.test(command.id)

  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-fg">{command.title}</span>
          {command.tier === 'destructive' ? (
            <Pill tone="warn">{t("settings.detail.asksFirst.34383")}</Pill>
          ) : command.tier === 'mutate' ? (
            <Pill tone="muted">{t("settings.detail.changesThings.b9943")}</Pill>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {shown.map(phrase => (
            <span key={phrase} className="rounded-md border border-line bg-white/5 px-2 py-0.5 text-[12px] text-fg-2">
              “{renderPhrase(phrase)}”
            </span>
          ))}
          {more > 0 && (
            <span className="px-1 py-0.5 text-[11.5px] text-fg-4" title={phrases.slice(4).join(' · ')}>
              +{more} {t("settings.detail.more.18789")}</span>
          )}
        </div>
        <div className="mt-1 text-[12px] leading-snug text-fg-3">{command.description}</div>
      </div>
      {canTry && (
        <GlassButton size="sm" variant="ghost" onClick={onTry} aria-label={t("settings.detail.try.64646", { value1: command.title })}>
          <IconPlayerPlay />
          {t("settings.detail.try.85d6c")}</GlassButton>
      )}
    </div>
  )
}
