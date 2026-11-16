import type { TextKey } from '../../../../shared/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconContrast, IconSparkles, IconTextSize } from '@tabler/icons-react'
import { useState } from 'react'
import { Chips, Toggle } from '../../../components/ui/glass.tsx'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { useT } from '../../../store/i18n.ts'
import { errorText, markSaved, readLocalFlag, SectionTitle, SettingsGroup, SettingsRow, writeLocal } from './shared.tsx'

/*
 * Text size and high contrast are shell-side: they set `font-size` / `data-contrast` on the
 * document element and persist in localStorage. `applyAccessibility()` re-applies them and is
 * called when the page first mounts (the stylesheet has no `data-contrast` rules yet; see report).
 */

export type TextSize = 'small' | 'default' | 'large'

const TEXT_SIZE_KEY = 'herald-os.a11y.text-size'
const CONTRAST_KEY = 'herald-os.a11y.high-contrast'
const TEXT_SIZES: { id: TextSize; label: TextKey; px: string }[] = [
  { id: 'small', label: "settings.detail.small.52632", px: '12px' },
  { id: 'default', label: "settings.detail.default.21b11", px: '13px' },
  { id: 'large', label: "settings.detail.large.ab805", px: '14.5px' }
]

function readTextSize(): TextSize {
  try {
    const raw = localStorage.getItem(TEXT_SIZE_KEY)

    return raw === 'small' || raw === 'large' ? raw : 'default'
  } catch {
    return 'default'
  }
}

function applyTextSize(size: TextSize): void {
  const px = TEXT_SIZES.find(item => item.id === size)?.px ?? '13px'
  document.documentElement.style.fontSize = size === 'default' ? '' : px
  document.body.style.fontSize = size === 'default' ? '' : px
}

function applyContrast(on: boolean): void {
  if (on) {
    document.documentElement.dataset.contrast = 'high'
  } else {
    delete document.documentElement.dataset.contrast
  }
}

/** Re-apply persisted accessibility choices to the document. Safe to call repeatedly. */
export function applyAccessibility(): void {
  applyTextSize(readTextSize())
  applyContrast(readLocalFlag(CONTRAST_KEY, false))
}

export function AccessibilitySection() {
  const t = useT()
  const prefs = useStore($prefs)
  const [textSize, setTextSize] = useState<TextSize>(readTextSize)
  const [contrast, setContrast] = useState(() => readLocalFlag(CONTRAST_KEY, false))

  const setMotion = async (next: boolean) => {
    try {
      await updatePrefs({ reduceMotion: next })
      markSaved()
    } catch (error) {
      notify({ title: t("settings.detail.couldNotSaveSetting.e2354"), body: errorText(error), level: 'error' })
    }
  }

  const changeText = (next: TextSize) => {
    setTextSize(next)
    applyTextSize(next)
    writeLocal(TEXT_SIZE_KEY, next)
    markSaved()
  }

  const changeContrast = (next: boolean) => {
    setContrast(next)
    applyContrast(next)
    writeLocal(CONTRAST_KEY, String(next))
    markSaved()
  }

  return (
    <>
      <SectionTitle title={t('settings.section.accessibility')} subtitle={t('settings.accessibility.subtitle')} />

      <SettingsGroup title={t("settings.detail.vision.c587c")}>
        <SettingsRow icon={<IconTextSize />} label={t("settings.detail.textSize.d6876")} description={t("settings.detail.scalesTheWholeInterface.b5bc9")} keywords="font zoom bigger smaller">
          <Chips items={TEXT_SIZES.map(item => ({ ...item, label: t(item.label) }))} value={textSize} onChange={changeText} />
        </SettingsRow>
        <SettingsRow icon={<IconContrast />} label={t("settings.detail.highContrast.415a8")} description={t("settings.detail.strongerStrokesAndTextMarksTheDocumentWith.7505a")} keywords="contrast readability">
          <Toggle checked={contrast} onChange={changeContrast} label={t("settings.detail.highContrast.415a8")} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.detail.motion.8ca34")}>
        <SettingsRow icon={<IconSparkles />} label={t("settings.detail.reduceMotion.297ef")} description={t("settings.detail.collapseNonessentialAnimationAcrossTheShellSameSetting.7bb96")} keywords="animation">
          <Toggle checked={prefs.reduceMotion} onChange={next => void setMotion(next)} label={t("settings.detail.reduceMotion.297ef")} />
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
