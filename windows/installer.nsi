; Maple Atlas Companion for Windows: the setup program (built by windows/build.sh).
; Installs to Program Files, adds Start menu and desktop shortcuts, an entry in
; Settings > Apps for uninstalling, and Windows Firewall rules (added by the app
; itself, see --repair-firewall) so the phone can reach it on any Wi-Fi.
Unicode true
!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!define APP "Maple Atlas Companion"
!define EXE "MapleAtlasCompanion.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MapleAtlasCompanion"

Name "${APP}"
OutFile "build\MapleAtlasCompanion-Setup.exe"
InstallDir "$PROGRAMFILES64\${APP}"
InstallDirRegKey HKLM "Software\${APP}" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "${APP} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Maple Atlas contributors"

!define MUI_ICON "build\installer\icon.ico"
!define MUI_UNICON "build\installer\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install ${APP}"
!define MUI_WELCOMEPAGE_TEXT "Follow your MapleStory Classic World game on your phone: your map and your position, live.$\r$\n$\r$\nEverything stays on your Wi-Fi. No account, no server, nothing sent to the internet.$\r$\n$\r$\nClick Install to continue."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APP} now"
!define MUI_FINISHPAGE_TEXT "${APP} is installed and allowed through Windows Firewall, so your phone can connect over your Wi-Fi.$\r$\n$\r$\nOpen it from the Start menu or the desktop."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Setup runs as administrator; the app itself should not, so it starts through Explorer.
Function LaunchApp
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\${EXE}"'
FunctionEnd

Section "Install"
  ; An older copy that is still running would lock the file.
  nsExec::Exec 'taskkill /IM "${EXE}" /F'
  Sleep 500
  SetOutPath "$INSTDIR"
  File "build\${EXE}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ; The 0.2.0 preview installed per user: remove that copy, its shortcuts and any
  ; firewall rules (including a "block" saved when the firewall prompt was dismissed).
  nsExec::Exec 'netsh advfirewall firewall delete rule name=all program="$LOCALAPPDATA\Programs\${APP}\${EXE}"'
  RMDir /r "$LOCALAPPDATA\Programs\${APP}"
  Delete "$DESKTOP\${APP}.lnk"
  Delete "$SMPROGRAMS\${APP}.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\${APP}"
  ; Inbound connections from the phone: the app adds its own Windows Firewall
  ; rules through the Windows Firewall API (setup already runs as administrator).
  ExecWait '"$INSTDIR\${EXE}" --repair-firewall' $0
  SetShellVarContext all
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}"
  WriteRegStr HKLM "Software\${APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "Maple Atlas"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "URLInfoAbout" "https://github.com/tal412/maple-atlas"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "EstimatedSize" 56000
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM "${EXE}" /F'
  Sleep 500
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ExecWait '"$INSTDIR\${EXE}" --remove-firewall' $0
  SetShellVarContext all
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  DeleteRegKey HKLM "Software\${APP}"
  ; The phone pairing in %APPDATA%\Maple Atlas Companion is kept, so a reinstall
  ; reconnects without scanning again.
SectionEnd
