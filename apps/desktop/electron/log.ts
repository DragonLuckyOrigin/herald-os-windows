import fs from 'node:fs'
import path from 'node:path'
import { hermesHome, isDev } from './paths.ts'

const MAX_TAIL = 400
const tail: string[] = []
let stream: fs.WriteStream | null = null
let streamUnavailable = false

function ensureStream(): fs.WriteStream | null {
  if (stream || streamUnavailable) {
    return stream
  }

  try {
    const dir = path.join(hermesHome(), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const next = fs.createWriteStream(path.join(dir, 'herald-os.log'), { flags: 'a' })
    next.on('error', () => {
      if (stream === next) {
        stream = null
      }
      streamUnavailable = true
    })
    stream = next
  } catch {
    stream = null
    streamUnavailable = true
  }

  return stream
}

export function log(scope: string, message: string): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}`
  tail.push(line)

  if (tail.length > MAX_TAIL) {
    tail.splice(0, tail.length - MAX_TAIL)
  }

  // Packaged Windows GUI processes do not own a durable console. Writing to the launcher pipe
  // after it exits raises EPIPE; the main-process uncaughtException handler would log that error
  // again and recurse indefinitely. Development retains terminal output, while packaged builds
  // use the file/tail sinks only.
  if (isDev) {
    try {
      console.log(line)
    } catch {
      // Logging must never become a product failure when its optional console sink disappears.
    }
  }

  const output = ensureStream()
  try {
    output?.write(line + '\n')
  } catch {
    if (stream === output) {
      stream = null
    }
    streamUnavailable = true
    output?.destroy()
  }
}

export function logTail(lines = 120): string[] {
  return tail.slice(-lines)
}
