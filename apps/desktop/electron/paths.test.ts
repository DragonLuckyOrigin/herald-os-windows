import { pathToFileURL } from 'node:url'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isShellPage, windowsConnectionPolicyPath } from './paths.ts'

const index = '/Applications/Herald OS.app/Contents/Resources/app.asar/dist/renderer/index.html'
const page = pathToFileURL(index).href

afterEach(() => vi.restoreAllMocks())

it('binds V3 policy to the native user profile, independent of environment and Hermes HOME',()=>{
  vi.spyOn(os, 'userInfo').mockReturnValue({username:'fixture',homedir:'C:\\Users\\fixture',uid:-1,gid:-1,shell:null})
  const expected='C:\\Users\\fixture\\DRAGON_OS\\connection-policy.json'
  expect(windowsConnectionPolicyPath({LOCALAPPDATA:'C:\\Users\\fixture\\AppData\\Local',USERPROFILE:'D:\\other-user',HOME:'D:\\other-home',HERMES_HOME:'D:\\old-home',HERALD_OS_BACKEND_URL:'http://127.0.0.1:9999'})).toBe(expected)
  expect(windowsConnectionPolicyPath({LOCALAPPDATA:'\\\\server\\share'})).toBe(expected)
  expect(windowsConnectionPolicyPath({})).toBe(expected)
})

it.each(['\\\\server\\share','C:\\Users\\..\\fixture','C:\\Users\\fixture.','C:\\Users\\fixture:stream','C:\\Users\\fixture\\',''])('rejects ambiguous native profile %j without a fallback',homedir=>{
  vi.spyOn(os, 'userInfo').mockReturnValue({username:'fixture',homedir,uid:-1,gid:-1,shell:null})
  expect(()=>windowsConnectionPolicyPath({LOCALAPPDATA:'C:\\apparently-safe'})).toThrow('SC1 invalid local policy directory')
})

it('fails closed when the native profile cannot be obtained',()=>{
  vi.spyOn(os, 'userInfo').mockImplementation(()=>{throw new Error('native profile unavailable')})
  expect(()=>windowsConnectionPolicyPath({LOCALAPPDATA:'C:\\apparently-safe'})).toThrow('native profile unavailable')
})

describe('isShellPage', () => {
  it('accepts the bundled renderer with any query or hash', () => {
    expect(isShellPage(page, index, undefined)).toBe(true)
    expect(isShellPage(`${page}?surface=dock`, index, undefined)).toBe(true)
    expect(isShellPage(`${page}#/settings`, index, undefined)).toBe(true)
  })

  it('refuses every other local file and remote page in a build', () => {
    expect(isShellPage('file:///Users/me/Downloads/page.html', index, undefined)).toBe(false)
    expect(isShellPage('https://example.com/', index, undefined)).toBe(false)
    expect(isShellPage('not a url', index, undefined)).toBe(false)
  })

  it('accepts only the dev server origin in development', () => {
    const dev = 'http://127.0.0.1:5180'

    expect(isShellPage('http://127.0.0.1:5180/?surface=main', index, dev)).toBe(true)
    expect(isShellPage('http://127.0.0.1:51801/', index, dev)).toBe(false)
    expect(isShellPage(page, index, dev)).toBe(false)
  })
})
