import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ home: '' }))

vi.mock('./paths.ts', () => ({
  hermesHome: () => fixture.home,
  isDev: false
}))

describe('desktop logging', () => {
  beforeEach(() => {
    fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-log-'))
    vi.resetModules()
  })

  it('does not write packaged desktop logs to a broken inherited console pipe', async () => {
    const brokenPipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => { throw brokenPipe })
    const { log, logTail } = await import('./log.ts')

    expect(() => log('main', 'probe')).not.toThrow()
    expect(logTail(1)[0]).toMatch(/\[main\] probe$/)
    expect(consoleLog).not.toHaveBeenCalled()
  })
})
