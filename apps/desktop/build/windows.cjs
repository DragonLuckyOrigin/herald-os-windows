// Permanent Windows identity. Other platforms retain their existing packaging configuration.
const { build } = require('../package.json')

module.exports = {
  ...build,
  appId: 'dev.iamluke.heraldos',
  productName: 'Herald OS',
  executableName: 'Herald OS',
  copyright: 'Copyright (c) 2026 Luke The Dev (@iamlukethedev). Windows port by Dragon Lucky Eagle Origin.',
  extraMetadata: {
    name: 'herald-os',
    productName: 'Herald OS',
    author: { name: 'Luke The Dev' },
    description: 'Herald OS: native Windows client for an independently running Hermes Core.'
  },
  // This developer candidate has no approved distribution channel.
  publish: null,
  win: {
    ...build.win,
    icon: 'build/icon.png'
  },
  nsis: {
    ...build.nsis,
    oneClick: true,
    perMachine: false,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Herald OS',
    artifactName: 'HeraldOS-${version}-win-${arch}-Setup.${ext}',
    include: 'build/windows-installer.nsh'
  }
}
