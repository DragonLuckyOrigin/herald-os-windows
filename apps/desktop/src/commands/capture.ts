import type { CaptureTool, ScreenshotMode } from '../../shared/ipc.ts'
import { CLI_UNAVAILABLE_MESSAGE, runHeraldOs } from '../lib/herald-os-cli.ts'
import { $env } from '../store/backend.ts'
import { $recording, askAbout, offerCapture } from '../store/capture.ts'
import { t } from '../store/i18n.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { isPanels } from '../store/shell.ts'
import { $windows, closeWindow, openApp } from '../store/windows.ts'

/* The capture suite: screenshots, recording, the colour picker, QR codes, text, markup, the camera. */

/** A Herald OS Linux tool run through the CLI (it draws its own selection where it needs one). */
async function linuxTool(argv: string[], title: string) {
  const outcome = await runHeraldOs(argv)

  if (outcome.unavailable) {
    return fail(t('commands.msg.capture.unavailable', { title, reason: CLI_UNAVAILABLE_MESSAGE.toLowerCase() }))
  }

  return outcome.ok ? ok(outcome.output || title, { data: { output: outcome.output } }) : fail(outcome.output || t('commands.msg.capture.didNotWork', { title }))
}

const isMac = () => $env.get()?.platform === 'darwin'

/** The colour picker, a QR code or text from the screen: macOS's own tools, through main. */
async function screenTool(tool: CaptureTool, linuxArgv: string[], title: string) {
  if (!isMac()) {
    return linuxTool(linuxArgv, title)
  }

  const result = await window.heraldOS.capture.tool(tool)

  if (result.cancelled) {
    return fail(t('commands.msg.capture.cancelled', { title }))
  }

  if (!result.text) {
    return fail(tool === 'qr' ? t('commands.msg.capture.noQr') : t('commands.msg.capture.noText'))
  }

  const summary =
    tool === 'colour'
      ? t('commands.msg.capture.copiedColour', { text: result.text })
      : tool === 'qr'
        ? t('commands.msg.capture.copiedQr', { text: result.text.length > 80 ? `${result.text.slice(0, 79)}…` : result.text })
        : t('commands.msg.capture.copiedLines', { count: Number(result.lines ?? 0) })

  return ok(summary, { data: { text: result.text } })
}

export const captureCommands: readonly OsCommand[] = [
  {
    id: 'capture.screenshot',
    title: 'Take a screenshot',
    description: 'Screenshot a region you select, the focused window or the whole screen; then offer to mark it up, copy it, ask Hermes about it or show it.',
    tier: 'act',
    args: [
      { name: 'mode', type: 'string', description: 'region, window or screen', enum: ['region', 'window', 'screen'] },
      { name: 'edit', type: 'boolean', description: 'Open it in Markup straight away' }
    ],
    phrases: ['take a screenshot', { phrase: 'screenshot the whole screen', args: { mode: 'screen' } }, { phrase: 'screenshot this window', args: { mode: 'window' } }],
    phrasesDe: [
      'mache einen screenshot',
      'mach einen screenshot',
      'nimm einen screenshot auf',
      { phrase: 'mache einen screenshot vom ganzen bildschirm', args: { mode: 'screen' } },
      { phrase: 'screenshot vom ganzen bildschirm', args: { mode: 'screen' } },
      { phrase: 'mache einen screenshot von diesem fenster', args: { mode: 'window' } },
      { phrase: 'screenshot von diesem fenster', args: { mode: 'window' } }
    ],
    run: async ({ mode, edit }, context) => {
      const file = await window.heraldOS.capture.screenshot(mode as ScreenshotMode)

      if (!file) {
        return fail(t('commands.msg.capture.noScreenshot'))
      }

      if (edit) {
        openApp('capture-editor', { payload: { file } })
      } else if (context.source !== 'agent') {
        offerCapture(file)
      }

      return ok(t('commands.msg.capture.saved', { name: file.split('/').pop() ?? file }), { data: { file } })
    }
  },
  {
    id: 'capture.record',
    title: 'Record the screen',
    description: 'Start or stop a screen recording (the whole screen, or a region you select), optionally with the microphone. The menu bar shows a red dot while it records.',
    tier: 'act',
    args: [
      { name: 'action', type: 'string', description: 'toggle, start or stop', enum: ['toggle', 'start', 'stop'] },
      { name: 'region', type: 'boolean', description: 'Select a region to record (Herald OS Linux)' },
      { name: 'audio', type: 'boolean', description: 'Record the microphone too' }
    ],
    phrases: [{ phrase: 'start recording the screen', args: { action: 'start' } }, { phrase: 'stop recording', args: { action: 'stop' } }, { phrase: 'record my screen', args: { action: 'start' } }],
    phrasesDe: [
      { phrase: 'starte die bildschirmaufnahme', args: { action: 'start' } },
      { phrase: 'bildschirmaufnahme starten', args: { action: 'start' } },
      { phrase: 'nimm meinen bildschirm auf', args: { action: 'start' } },
      { phrase: 'beende die bildschirmaufnahme', args: { action: 'stop' } },
      { phrase: 'stoppe die aufnahme', args: { action: 'stop' } }
    ],
    run: async ({ action, region, audio }) => {
      const state = await window.heraldOS.capture.record((action as 'toggle' | 'start' | 'stop') ?? 'toggle', { region: Boolean(region), audio: Boolean(audio) })

      return ok(state.recording ? t('commands.msg.capture.recording') : state.file ? t('commands.msg.capture.saved', { name: state.file.split('/').pop() ?? state.file }) : t('commands.msg.capture.notRecording'), { data: { ...state } })
    }
  },
  {
    id: 'capture.edit',
    title: 'Mark up a screenshot',
    description: 'Open a picture in Markup: arrows, boxes, highlights, text, and hiding private details.',
    tier: 'act',
    args: [{ name: 'file', type: 'string', description: 'The picture', required: true }],
    hidden: true,
    run: ({ file }) => {
      openApp('capture-editor', { payload: { file: String(file) } })

      return ok(t('commands.msg.capture.markupOpened'))
    }
  },
  {
    id: 'capture.copy',
    title: 'Copy a picture',
    description: 'Put a picture on the clipboard.',
    tier: 'act',
    args: [{ name: 'file', type: 'string', description: 'The picture', required: true }],
    hidden: true,
    run: async ({ file }) => {
      await window.heraldOS.capture.copyImage(String(file))

      return ok(t('commands.msg.capture.copiedClipboard'))
    }
  },
  {
    id: 'capture.ask',
    title: 'Ask Hermes about a picture',
    description: 'Open "Ask Hermes" with a picture attached.',
    tier: 'act',
    args: [
      { name: 'file', type: 'string', description: 'The picture', required: true },
      { name: 'question', type: 'string', description: 'The question, if already known' }
    ],
    hidden: true,
    run: ({ file, question }) => {
      askAbout(String(file), question ? String(question) : '')

      return ok(t('commands.msg.capture.askQuestion'))
    }
  },
  {
    id: 'capture.color',
    title: 'Pick a colour from the screen',
    description: 'Click anywhere on screen to copy that colour (#rrggbb) to the clipboard.',
    tier: 'act',
    args: [],
    phrases: ['pick a colour', 'pick a color from the screen', 'what colour is this'],
    phrasesDe: ['wähle eine farbe vom bildschirm', 'welche farbe ist das', 'farbe aufnehmen', 'pipette'],
    run: () => screenTool('colour', ['capture', 'color'], t('commands.msg.capture.toolColour'))
  },
  {
    id: 'capture.qr',
    title: 'Read a QR code',
    description: 'Select a QR code or barcode on screen and copy what it says.',
    tier: 'act',
    args: [],
    phrases: ['read this qr code', 'scan the qr code'],
    phrasesDe: ['lies diesen qr-code', 'lies diesen qr code', 'scanne den qr-code', 'scanne den qr code'],
    run: () => screenTool('qr', ['capture', 'qr'], t('commands.msg.capture.toolQr'))
  },
  {
    id: 'capture.text',
    title: 'Copy text from the screen',
    description: 'Select part of the screen and copy the text in it (OCR).',
    tier: 'act',
    args: [],
    phrases: ['copy the text on screen', 'read the text on screen'],
    phrasesDe: ['kopiere den text auf dem bildschirm', 'lies den text auf dem bildschirm', 'text vom bildschirm kopieren'],
    run: () => screenTool('text', ['capture', 'text'], t('commands.msg.capture.toolText'))
  },
  {
    id: 'capture.transcode',
    title: 'Convert a recording',
    description: 'Turn a recording into a GIF, a smaller MP4 or a WebM (Herald OS Linux, with ffmpeg).',
    tier: 'act',
    args: [
      { name: 'file', type: 'string', description: 'The recording', required: true },
      { name: 'format', type: 'string', description: 'gif, mp4 or webm', enum: ['gif', 'mp4', 'webm'] }
    ],
    run: ({ file, format }) => linuxTool(['capture', 'transcode', String(file), String(format ?? 'gif')], t('commands.msg.capture.toolConvert'))
  },
  {
    id: 'capture.share',
    title: 'Share a file',
    description: 'Copy a file to the clipboard and open LocalSend when it is installed (Herald OS Linux).',
    tier: 'act',
    args: [{ name: 'file', type: 'string', description: 'The file', required: true }],
    run: ({ file }) => linuxTool(['capture', 'share', String(file)], t('commands.msg.capture.toolShare'))
  },
  {
    id: 'camera.show',
    title: 'Camera bubble',
    description: 'Show (or hide) your camera in a round bubble, for screen recordings.',
    tier: 'act',
    args: [{ name: 'enabled', type: 'boolean', description: 'false to hide it' }],
    phrases: [{ phrase: 'show my camera', args: { enabled: true } }, { phrase: 'hide my camera', args: { enabled: false } }],
    phrasesDe: [
      { phrase: 'zeige meine kamera', args: { enabled: true } },
      { phrase: 'blende meine kamera ein', args: { enabled: true } },
      { phrase: 'verberge meine kamera', args: { enabled: false } },
      { phrase: 'blende meine kamera aus', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      if (enabled === false) {
        if (isPanels) {
          await window.heraldOS.shell.close('window:camera')
        } else {
          Object.values($windows.get())
            .filter(win => win.appId === 'camera')
            .forEach(win => closeWindow(win.id))
        }

        return ok(t('commands.msg.capture.cameraHidden'))
      }

      openApp('camera')

      return ok($recording.get().recording ? t('commands.msg.capture.cameraOnRecording') : t('commands.msg.capture.cameraOn'))
    }
  }
]
