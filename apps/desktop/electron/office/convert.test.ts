import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { convertArgs, convertWithLibreOffice, sofficeCandidates } from './convert.ts'

describe('sofficeCandidates', () => {
  it('tries the app bundle on the Mac before PATH', () => {
    const list = sofficeCandidates('darwin', { PATH: '/opt/homebrew/bin:/usr/bin' }, '/Users/me')

    expect(list[0]).toBe('/Applications/LibreOffice.app/Contents/MacOS/soffice')
    expect(list[1]).toBe('/Users/me/Applications/LibreOffice.app/Contents/MacOS/soffice')
    expect(list).toContain('/opt/homebrew/bin/soffice')
  })

  it('tries PATH first on Linux, then the usual install places and Flatpak', () => {
    const list = sofficeCandidates('linux', { PATH: '/usr/local/bin' })

    expect(list.slice(0, 2)).toEqual(['/usr/local/bin/soffice', '/usr/local/bin/libreoffice'])
    expect(list).toContain('/usr/lib/libreoffice/program/soffice')
    expect(list.at(-1)).toBe('/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice')
  })
})

describe('convertArgs', () => {
  it('runs headless with a profile of its own', () => {
    const root = path.join(os.tmpdir(), "Herald Office Ä & '")
    const input = path.join(root, 'in', 'Plan.odt')
    const output = path.join(root, 'out')
    const profile = path.join(root, 'profile')
    expect(convertArgs(input, 'docx', output, profile)).toEqual([
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--headless',
      '--norestore',
      '--nologo',
      '--nolockcheck',
      '--convert-to',
      'docx',
      '--outdir',
      output,
      input
    ])
  })
})

describe('Windows LibreOffice candidates', () => {
  it('uses native executable names, PATH separators and deduplicated Program Files', () => {
    expect(sofficeCandidates('win32', { PATH: 'D:\\Office Tools;C:\\Tools', ProgramW6432: 'C:\\Program Files', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' })).toEqual([
      'D:\\Office Tools\\soffice.exe', 'D:\\Office Tools\\libreoffice.exe',
      'C:\\Tools\\soffice.exe', 'C:\\Tools\\libreoffice.exe',
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    ])
  })
  it('ignores relative roots and has no invented Unix fallback', () => {
    expect(sofficeCandidates('win32', { Path: 'relative', ProgramFiles: 'relative' })).toEqual([])
    expect(sofficeCandidates('win32', {})).toEqual([])
  })
})

describe('convertWithLibreOffice', () => {
  it('refuses formats it does not convert to', async () => {
    await expect(convertWithLibreOffice('/tmp/a.odt', 'exe')).rejects.toThrow('not asked for .exe')
  })
})
