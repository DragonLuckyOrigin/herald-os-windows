!include "WordFunc.nsh"

; Native version comparison, shared by the install hook and its non-installing test fixture.
!macro dragonCheckUpgradeVersion INSTALLED_VERSION
  ${VersionCompare} "${VERSION}" "${INSTALLED_VERSION}" $R1
  ${If} $R1 != 1
    MessageBox MB_OK|MB_ICONEXCLAMATION "Dieses Paket ist nicht neuer als die installierte Herald-Version. Ein Downgrade oder Austausch derselben Version wurde verhindert." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

; electron-builder has selected the native registry view and install mode before this hook.
!macro customInit
  ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $R0 != ""
    !insertmacro dragonCheckUpgradeVersion "$R0"
  ${Else}
    ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${If} $R0 != ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "Die installierte Herald-Version konnte nicht bestimmt werden. Setup wurde angehalten." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

; Supported electron-builder hook: never terminate an application during install/update/uninstall.
; A process scan error also blocks installation. 603 is nsProcess's "process not found" result.
; An exact executable-name match may conservatively block another user's Herald, but cannot kill it.
!macro customCheckAppRunning
  nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
  Pop $R0
  nsProcess::_Unload
  ${If} $R0 != 603
    MessageBox MB_OK|MB_ICONEXCLAMATION "Bitte Herald OS normal beenden und das Setup erneut starten. Die Prozessfreiheit konnte nicht bestätigt werden. Hermes kann geöffnet bleiben." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
