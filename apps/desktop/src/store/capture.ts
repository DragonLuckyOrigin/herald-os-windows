import { t as uiT } from './i18n.ts'
import { atom } from 'nanostores'
import type { RecordingState } from '../../shared/ipc.ts'
import { notify } from './notifications.ts'
import { isMainSurface, isPanels, openSurface } from './shell.ts'
import { openAsk } from './surface.ts'

/** The screen recording, as main reports it (every window: the menu bar shows a red dot). */
export const $recording = atom<RecordingState>({ recording: false })

const fileName = (file: string) => file.split('/').pop() ?? file

/** After a screenshot: a notification that offers to mark it up, copy it, ask Hermes or show it. */
export function offerCapture(file: string): void {
  notify({
    title: uiT("ui.30be38811168"),
    body: fileName(file),
    level: 'success',
    key: `capture:${file}`,
    actions: [
      { label: uiT("ui.464c4ffd019e"), command: 'capture.edit', args: { file } },
      { label: uiT("ui.e21f935f11d7"), command: 'capture.copy', args: { file } },
      { label: uiT("ui.b29c6b24c618"), command: 'capture.ask', args: { file } },
      { label: uiT("ui.0df6f1cad36c"), command: 'files.show', args: { path: file } }
    ]
  })
}

/** Open "Ask Hermes" with a file attached: the command overlay on Linux, the ask panel on a Mac. */
export function askAbout(file: string, question = ''): void {
  if (isPanels) {
    openSurface('command', { type: 'ask', text: question, attachments: [file] })
  } else {
    openAsk({ text: question, attachments: [file] })
  }
}

let bound = false

export function bindRecording(): () => void {
  const capture = window.heraldOS?.capture

  if (bound || !capture?.onRecordChanged) {
    return () => undefined
  }

  bound = true
  void capture
    .recordState()
    .then(state => $recording.set(state))
    .catch(() => undefined)

  const off = capture.onRecordChanged(state => {
    const before = $recording.get()
    $recording.set(state)

    // The Hermes window says where a finished recording went (once, not in every window).
    if (isMainSurface && before.recording && !state.recording && state.file) {
      const file = state.file
      notify({
        title: uiT("ui.b81274bafb79"),
        body: fileName(file),
        level: 'success',
        key: `recording:${file}`,
        actions: [
          { label: uiT("ui.0df6f1cad36c"), command: 'files.show', args: { path: file } },
          { label: uiT("ui.73f3e5d91848"), command: 'capture.transcode', args: { file, format: 'gif' } },
          { label: uiT("ui.29887a5ff984"), command: 'capture.share', args: { file } }
        ]
      })
    }
  })

  return () => {
    off()
    bound = false
  }
}
