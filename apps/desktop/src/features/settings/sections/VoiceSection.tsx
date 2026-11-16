import { t as uiT } from '../../../store/i18n.ts'
import type { TextKey } from '../../../../shared/i18n.ts'
import { t, useT, $locale } from '../../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconBellRinging, IconBolt, IconClockPause, IconCoin, IconEar, IconEye, IconHourglass, IconKeyboard, IconLanguage, IconListDetails, IconMicrophone, IconPlayerPlay, IconSpeakerphone, IconVolume, IconWaveSine } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { MicPermission, VoiceEngine, VoicePrefs } from '../../../../shared/ipc.ts'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { Meter } from '../../../components/ui/primitives.tsx'
import { describeDeviceChoice } from '../../../lib/audio-devices.ts'
import { audioScope, deviceNoun, hostPlatform } from '../../../lib/platform-labels.ts'
import { canOpenPrivacyPanes, openPrivacyPane } from '../../../lib/privacy-pane.ts'
import { logFailure } from '../../../lib/report.ts'
import { rest } from '../../../lib/rest.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { $inputDevices } from '../../../lib/voice/audio-capture.ts'
import { LOCAL_STT_MODELS } from '../../../lib/voice/stt-tuning.ts'
import { $inputChoice, $micLevelPercent, chooseInputDevice, watchAudioDevices } from '../../../store/audio-devices.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { $voice, $voiceActive, LIVE_RATE_PER_MINUTE, liveSecondsToday, speakWithFreeFallback, startVoice } from '../../../store/voice.ts'
import { fetchLiveStatus, type LiveStatus } from '../../../store/voice-live-status.ts'
import { $wake, setWakeWordEnabled } from '../../../store/wake.ts'
import { errorText, focusSettings, InlineNote, markSaved, MenuDropdown, type MenuItem, RadioCard, SectionTitle, SettingsGroup, SettingsRow, Stepper } from './shared.tsx'

/*
 * Voice: the two engines (free chained pipeline, paid GPT-Live), how a conversation starts (wake
 * word, hotkey), the speech providers Hermes uses (written to the runtime's config.yaml through
 * PUT /api/config), and the Live cost controls. See docs/VOICE.md.
 */

interface HermesConfig {
  stt?: { provider?: string; local?: { model?: string }; [key: string]: unknown }
  tts?: { provider?: string; [key: string]: unknown }
  [key: string]: unknown
}

const STT_PROVIDERS: { id: string; label: TextKey; description: TextKey }[] = [
  { id: 'nous', label: "settings.detail.nousSubscription.fe336", description: "settings.detail.openaiTranscriptionThroughTheNousGatewayNoExtra.6af0b" },
  { id: 'local', label: "settings.detail.onThisDeviceFasterwhisper.0bacc", description: "settings.detail.freeAndPrivateSlowerOnLongUtterances.b981d" },
  { id: 'openai', label: "settings.detail.literal.OpenAI", description: "settings.detail.gpt4ominitranscribeWithYourOPENAIAPIKEY.aef96" },
  { id: 'groq', label: "settings.detail.literal.GroqWhisper", description: "settings.detail.literal.GROQAPIKEY" },
  { id: 'mistral', label: "settings.detail.literal.MistralVoxtral", description: "settings.detail.literal.MISTRALAPIKEY" },
  { id: 'elevenlabs', label: "settings.detail.literal.ElevenLabsScribe", description: "settings.detail.literal.ELEVENLABSAPIKEY" }
] as const

const TTS_PROVIDERS: { id: string; label: TextKey; description: TextKey }[] = [
  { id: 'nous', label: "settings.detail.nousSubscription.fe336", description: "settings.detail.gpt4ominittsThroughTheNousGatewayNoExtraCost.790f8" },
  { id: 'edge', label: "settings.detail.edgeNeuralVoices.3a36b", description: "settings.detail.freeNoKeyWholeSentencesAtATime.72a32" },
  { id: 'openai', label: "settings.detail.literal.OpenAI", description: "settings.detail.gpt4ominittsStreamsSentenceBySentence.9fcda" },
  { id: 'elevenlabs', label: "settings.detail.literal.ElevenLabs", description: "settings.detail.mostExpressiveStreamsPaid.7ffb4" },
  { id: 'neutts', label: "settings.detail.neuttsLocal.a7c9d", description: "settings.detail.runsOnThisDeviceNeedsTheNeuttsExtra.6be19" },
  { id: 'kittentts', label: "settings.detail.kittenttsLocal.0177b", description: "settings.detail.tinyLocalModel.91231" },
  { id: 'piper', label: "settings.detail.piperLocal.252c8", description: "settings.detail.fastLocalVoices.71501" }
] as const

const IDLE_OPTIONS = [20, 30, 45, 60, 120, 300]
const CAP_OPTIONS = [0, 15, 30, 60, 120, 240]

/** The picker entry that means "follow the system"; prefixed so it can never be a device id. */
const AUTOMATIC_DEVICE = '__automatic__'

export function VoiceSection() {
  useT()
  const prefs = useStore($prefs)
  const voice = prefs.voice
  const wake = useStore($wake)
  const live = useStore($voice).live
  const active = useStore($voiceActive)
  const config = useBackendData(() => rest.get<HermesConfig>('/api/config'))
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(live.status)
  const [mic, setMic] = useState<MicPermission>('unknown')
  const [hotkeyDraft, setHotkeyDraft] = useState(voice.hotkey)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void fetchLiveStatus().then(setLiveStatus)
    void window.heraldOS.voice.microphoneStatus().then(setMic).catch(logFailure('voice.microphoneStatus'))
  }, [])

  useEffect(() => setHotkeyDraft(voice.hotkey), [voice.hotkey])

  const save = async (patch: Partial<VoicePrefs>) => {
    try {
      await updatePrefs({ voice: { ...$prefs.get().voice, ...patch } })
      markSaved()
    } catch (error) {
      notify({ title: t("settings.detail.couldNotSaveSetting.e2354"), body: errorText(error), level: 'error' })
    }
  }

  const saveConfig = async (section: 'stt' | 'tts', provider: string) => {
    try {
      await rest.put('/api/config', { config: { [section]: { provider } } })
      config.reload()
      markSaved()
    } catch (error) {
      notify({ title: t("settings.detail.couldNotUpdateHermesConfig.3b2c7"), body: errorText(error), level: 'error' })
    }
  }

  const setEngine = async (engine: VoiceEngine) => {
    if (engine === 'live' && liveStatus && !liveStatus.available) {
      notify({ title: t("settings.detail.liveIsNotAvailable.85849"), body: liveStatus.reason ?? t("settings.detail.gptliveCannotStartOnThisRuntime.16f44"), level: 'warn' })

      return
    }

    await save({ engine })
  }

  const requestMic = async () => {
    try {
      setMic(await window.heraldOS.voice.requestMicrophone())
    } catch (error) {
      notify({ title: t("settings.detail.microphone.18635"), body: errorText(error), level: 'error' })
    }
  }

  const sayHello = async () => {
    setTesting(true)

    try {
      await speakWithFreeFallback('Hello. This is Hermes, speaking from Herald OS.')
      config.reload()
      markSaved()
    } catch (error) {
      notify({ title: t("settings.detail.speechTestFailed.f5c47"), body: errorText(error), level: 'error' })
    } finally {
      setTesting(false)
    }
  }

  const saveLocalModel = async (model: string) => {
    try {
      await rest.put('/api/config', { config: { stt: { local: { model } } } })
      await updatePrefs({ voice: { ...$prefs.get().voice, sttTuned: true } })
      config.reload()
      markSaved()
    } catch (error) {
      notify({ title: t("settings.detail.couldNotUpdateHermesConfig.3b2c7"), body: errorText(error), level: 'error' })
    }
  }

  const sttProvider = config.data?.stt?.provider ?? 'local'
  const localModel = config.data?.stt?.local?.model ?? 'base'
  const ttsProvider = config.data?.tts?.provider ?? 'edge'
  const todayMinutes = Math.round(liveSecondsToday(voice) / 60)
  const price = (value: number) => new Intl.NumberFormat($locale.get(), { style: 'currency', currency: 'USD' }).format(value)
  const todayCost = price((liveSecondsToday(voice) / 60) * LIVE_RATE_PER_MINUTE)

  // Audio devices: Herald keeps its own microphone where it is one app among others, and the Sound
  // panel in the menu bar shows the same control. Herald OS Linux sets the machine's devices instead.
  const micDevices = useStore($inputDevices)
  const micChoice = useStore($inputChoice)
  const micLevel = useStore($micLevelPercent)

  useEffect(() => watchAudioDevices(), [])

  const automaticMic = micDevices.devices.find(device => device.isSystem)
  // From the resolved choice, not the stored id: a device found by its name has a new id.
  const selectedMic = micChoice.reason === 'chosen' && micChoice.device ? micChoice.device.id : AUTOMATIC_DEVICE
  const micItems: readonly MenuItem[] = [
    { id: AUTOMATIC_DEVICE, label: t("settings.detail.automatic.d461a"), description: automaticMic ? t("settings.detail.followTheSystem.d2148", { value1: automaticMic.label }) : t("settings.detail.followTheSystem.d153c") },
    ...micDevices.devices.map(device => ({ id: device.id, label: device.label, description: device.isSystem ? t("settings.detail.theSystemDefaultRightNow.3708d") : undefined }))
  ]
  const micLabel = micDevices.devices.find(device => device.id === selectedMic)?.label ?? t('settings.common.automatic')

  const selectMicrophone = async (id: string) => {
    const device = micDevices.devices.find(one => one.id === id)

    await chooseInputDevice(id === AUTOMATIC_DEVICE || !device ? null : { id: device.id, label: device.label })
    markSaved()
  }

  return (
    <>
      <SectionTitle title={t('settings.section.voice')} subtitle={t("settings.detail.talkToHermesAndHearItAnswerHermes.457e6")} />

      <SettingsGroup title={t("settings.detail.voice.87bf2")}>
        <SettingsRow icon={<IconMicrophone />} label={t("settings.detail.enableVoice.c7ecf")} description={t("settings.detail.showsTheMicrophoneInTheMenuBarAnd.f7c16")} keywords="talk speak jarvis">
          <Toggle checked={voice.enabled} onChange={next => void save({ enabled: next, wakeWord: next ? voice.wakeWord : false })} label={t("settings.detail.enableVoice.c7ecf")} />
        </SettingsRow>
        <SettingsRow
          icon={<IconMicrophone />}
          label={t("settings.detail.microphoneAccess.1f043")}
          description={mic === 'granted' ? t('settings.voice.granted') : mic === 'denied' || mic === 'restricted' ? hostPlatform() === 'win32' ? t('settings.voice.windowsDenied') : t("settings.detail.deniedAllowHeraldOSUnderSystemSettingsPrivacy.2ade0") : t("settings.detail.notAskedYetTheFirstConversationAsks.8ef36")}
          keywords="permission privacy"
        >
          {(mic === 'denied' || mic === 'restricted') && canOpenPrivacyPanes() && (
            <GlassButton size="sm" onClick={() => void openPrivacyPane('microphone').catch(logFailure('shell.openExternal'))} aria-label={t("settings.detail.openTheMicrophonePaneInSystemSettings.75631")}>
              {t("settings.detail.openSystemSettings.18196")}</GlassButton>
          )}
          {mic !== 'granted' && (
            <GlassButton size="sm" onClick={() => void requestMic()} aria-label={t("settings.detail.requestMicrophoneAccess.e7fa9")}>
              {t("settings.detail.requestAccess.b06f1")}</GlassButton>
          )}
        </SettingsRow>
        <SettingsRow icon={<IconListDetails />} label={t("settings.detail.whatYouCanSay.f39ee")} description={t("settings.detail.everyVoiceCommandWithExamplesYouCanAlso.37187")} keywords="commands help list">
          <GlassButton size="sm" onClick={() => focusSettings({ section: 'commands' })} aria-label={t("settings.detail.showVoiceCommands.3f27a")}>
            {t("settings.detail.showCommands.8d984")}</GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconPlayerPlay />} label={t("settings.detail.tryIt.fe695")} description={t("settings.detail.hearTheConfiguredVoiceOrStartAConversation.994b6")}>
          <GlassButton size="sm" onClick={() => void sayHello()} disabled={testing} aria-label={t("settings.detail.playATestSentence.a13e0")}>
            <IconVolume />
            {testing ? t("settings.detail.speaking.e86dd") : t("settings.detail.sayHello.6d995")}
          </GlassButton>
          <GlassButton size="sm" variant="primary" onClick={() => void startVoice('button')} disabled={active} aria-label={t("settings.detail.startAVoiceConversation.a2fa4")}>
            {active ? t("settings.detail.listening.bbb41") : t("settings.detail.startTalking.a5e3c")}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>

      {audioScope() === 'app' && (
        <SettingsGroup title={t("settings.detail.audioDevices.02f3a")}>
          <SettingsRow
            icon={<IconMicrophone />}
            label={t("settings.detail.microphone.18635")}
            description={describeDeviceChoice(micChoice, 'input')}
            keywords="microphone input device airpods bluetooth headset usb audio"
            below={
              voice.enabled ? (
                <div className="flex items-center">
                  <Meter value={micLevel} className="flex-1" />
                </div>
              ) : undefined
            }
          >
            <MenuDropdown
              ariaLabel={t("settings.detail.microphone.18635")}
              label={micLabel}
              items={micItems}
              value={selectedMic}
              onSelect={id => void selectMicrophone(String(id))}
              disabled={!voice.enabled}
            />
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsGroup title={t("settings.detail.engine.8e75e")}>
        <SettingsRow
          label={t("settings.detail.conversationEngine.b9b24")}
          description={t("settings.detail.freeYourMicIsTranscribedHermesAnswersAnd.d7252")}
          keywords="chained gpt-live realtime cost"
          below={
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <RadioCard icon={<IconWaveSine />} label={t("settings.detail.free.f411a")} description={t("settings.detail.noExtraCostSTTAndTTSProvidersBelow.eb9b9")} selected={voice.engine === 'chained'} onSelect={() => void setEngine('chained')} />
                <RadioCard
                  icon={<IconBolt />}
                  label={uiT("ui.b64ac05f17e6")}
                  description={liveStatus?.available ? t('settings.voice.minutePrice', { price: price(LIVE_RATE_PER_MINUTE) }) : t("settings.detail.needsAnOpenAIKeyAndHermes0213.65f4c")}
                  selected={voice.engine === 'live'}
                  onSelect={() => void setEngine('live')}
                  disabled={liveStatus ? !liveStatus.available : false}
                />
              </div>
              {liveStatus && !liveStatus.available && <InlineNote tone="info">{t('settings.voice.liveReason', { reason: liveStatus.reason ?? '' })}</InlineNote>}
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.detail.startingAConversation.29f05")}>
        <SettingsRow
          icon={<IconEar />}
          label={t("settings.detail.wakeWord.67d7b", { value1: wake.phrase })}
          description={
            wake.listening
              ? t(wake.capture === 'local' ? 'settings.voice.listeningLocal' : 'settings.voice.listening')
              : wake.error
                ? wake.error
                : t('settings.voice.wakePrivacy', { device: deviceNoun() })
          }
          keywords="hey hermes always listening"
        >
          {wake.listening && <Pill tone="ok" dot>{t("settings.detail.armed.b65bd")}</Pill>}
          <Toggle checked={voice.wakeWord} onChange={next => void setWakeWordEnabled(next).then(markSaved)} label={t("settings.detail.wakeWord.030a9")} />
        </SettingsRow>
        <SettingsRow icon={<IconKeyboard />} label={t("settings.detail.globalHotkey.dccb7")} description={t("settings.detail.togglesAConversationFromAnyAppElectronAccelerator.fbbc4")} keywords="shortcut push to talk">
          <input
            value={hotkeyDraft}
            onChange={event => setHotkeyDraft(event.target.value)}
            onBlur={() => hotkeyDraft.trim() !== voice.hotkey && void save({ hotkey: hotkeyDraft.trim() })}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
            aria-label={t("settings.detail.globalVoiceHotkey.4812d")}
            spellCheck={false}
            className="glass-input h-8 w-[200px] rounded-lg px-2.5 font-mono text-[12px] text-fg outline-none"
          />
        </SettingsRow>
        <SettingsRow icon={<IconHourglass />} label={t("settings.detail.followupWindow.201d4")} description={t("settings.detail.secondsTheMicKeepsListeningAfterHermesFinishes.8476e")} keywords="continue listening">
          <Stepper value={voice.followUpSeconds} min={0} max={30} onChange={next => void save({ followUpSeconds: next })} label={t("settings.detail.followupSeconds.91e0b")} />
        </SettingsRow>
        <SettingsRow icon={<IconEye />} label={t("settings.detail.followHermes.28068")} description={t("settings.detail.showWhatHermesChangesAsItWorksA.a6660")} keywords="watch show work">
          <Toggle checked={voice.followHermes} onChange={next => void save({ followHermes: next })} label={t("settings.detail.followHermes.28068")} />
        </SettingsRow>
        <SettingsRow icon={<IconBellRinging />} label={t("settings.detail.speakNotifications.4dbc1")} description={t("settings.detail.readHermesNotificationsAloudMissionsRemindersWhileVoice.c41ca")} keywords="announce read aloud">
          <Toggle checked={voice.announceNotifications} onChange={next => void save({ announceNotifications: next })} label={t("settings.detail.speakNotifications.4dbc1")} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.detail.speechProvidersFreeEngine.020f4")}>
        <SettingsRow icon={<IconLanguage />} label={t("settings.detail.speechToText.4dfe4")} description={config.error ? t("settings.detail.couldNotReadHermesConfig.30749", { value1: config.error }) : t("settings.detail.whichServiceTurnsYourVoiceIntoTextStored.79b47")} keywords="stt transcribe whisper">
          <MenuDropdown ariaLabel={t("settings.detail.speechtotextProvider.5c61b")} label={STT_PROVIDERS.some(p => p.id === sttProvider) ? t(STT_PROVIDERS.find(p => p.id === sttProvider)!.label) : sttProvider} value={sttProvider} items={STT_PROVIDERS.map(p => ({ ...p, label: t(p.label), description: t(p.description) }))} onSelect={id => void saveConfig('stt', id)} disabled={!config.data} />
        </SettingsRow>
        {sttProvider === 'local' && (
          <SettingsRow icon={<IconWaveSine />} label={t("settings.detail.transcriptionModel.e8fac")} description={t("settings.detail.largerModelsHearShortCommandsAndNamesBetter.e02a5")} keywords="whisper accuracy model local">
            <MenuDropdown ariaLabel={t("settings.detail.localTranscriptionModel.3036a")} label={LOCAL_STT_MODELS.find(m => m.id === localModel)?.label ?? localModel} value={localModel} items={LOCAL_STT_MODELS} onSelect={id => void saveLocalModel(id)} disabled={!config.data} />
          </SettingsRow>
        )}
        <SettingsRow icon={<IconSpeakerphone />} label={t("settings.detail.textToSpeech.71e02")} description={t("settings.detail.whichVoiceSpeaksHermessRepliesStoredInHermes.a1d14")} keywords="tts voice speak">
          <MenuDropdown ariaLabel={t("settings.detail.texttospeechProvider.92019")} label={TTS_PROVIDERS.some(p => p.id === ttsProvider) ? t(TTS_PROVIDERS.find(p => p.id === ttsProvider)!.label) : ttsProvider} value={ttsProvider} items={TTS_PROVIDERS.map(p => ({ ...p, label: t(p.label), description: t(p.description) }))} onSelect={id => void saveConfig('tts', id)} disabled={!config.data} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.detail.liveCostControls.8fcc0")}>
        <SettingsRow icon={<IconClockPause />} label={t("settings.detail.closeAfterSilence.13fb5")} description={t("settings.detail.aLiveSessionBillsPerSecondWhileOpen.ae934")} keywords="idle timeout">
          <MenuDropdown ariaLabel={t("settings.detail.liveIdleTimeout.956ef")} label={`${voice.liveIdleSeconds} s`} value={String(voice.liveIdleSeconds)} items={IDLE_OPTIONS.map(s => ({ id: String(s), label: t("settings.detail.seconds.6fd89", { value1: s }) }))} onSelect={id => void save({ liveIdleSeconds: Number(id) })} />
        </SettingsRow>
        <SettingsRow icon={<IconCoin />} label={t("settings.detail.dailyCap.9a7e2")} description={t('settings.voice.todayCost', { minutes: todayMinutes, price: todayCost })} keywords="budget limit spend">
          <MenuDropdown ariaLabel={t("settings.detail.liveDailyCap.b656c")} label={voice.liveDailyCapMinutes ? `${voice.liveDailyCapMinutes} min` : t("settings.detail.noCap.59db2")} value={String(voice.liveDailyCapMinutes)} items={CAP_OPTIONS.map(m => ({ id: String(m), label: m ? t('settings.voice.capPrice', { minutes: m, price: price(m * LIVE_RATE_PER_MINUTE) }) : t("settings.detail.noCap.59db2") }))} onSelect={id => void save({ liveDailyCapMinutes: Number(id) })} />
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
