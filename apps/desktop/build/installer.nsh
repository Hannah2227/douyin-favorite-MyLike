; Uninstall removes the installation directory. Only accept a dedicated
; empty directory for a new install, or the previously registered install.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; The wizard owns the optional desktop shortcut. NSIS manages the Start menu entry.
!macro RemoveShortcut link
  ${If} ${FileExists} "${link}"
    WinShell::UninstShortcut "${link}"
    Delete "${link}"
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isKeepShortcuts}
    !insertmacro RemoveShortcut "$oldDesktopLink"
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Var desktopShortcut
Var reinstalling

!macro customHeader
Function ValidateInstallTarget
  Pop $0
  System::Call 'shlwapi::PathIsRelativeW(w r0)i.r1'
  ${If} $0 == ""
  ${OrIf} $1 != 0
    Push 0
    Return
  ${EndIf}
  GetFullPathName $0 "$0"
  System::Call 'shlwapi::PathIsRootW(w r0)i.r1'
  ${If} $1 != 0
    Push 0
    Return
  ${EndIf}
  ReadRegStr $1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $1 != ""
    GetFullPathName $1 "$1"
    ${If} $0 == $1
      Push 1
      Return
    ${EndIf}
  ${EndIf}
  FindFirst $1 $2 "$0\*.*"
  ${While} $2 != ""
    ${If} $2 != "."
    ${AndIf} $2 != ".."
      FindClose $1
      Push 0
      Return
    ${EndIf}
    FindNext $1 $2
  ${EndWhile}
  FindClose $1
  Push 1
FunctionEnd

!macroend

!macro UpdateShortcut link selection
  ${If} ${selection} == ${BST_CHECKED}
    CreateShortCut "${link}" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "${link}" "${APP_ID}"
  ${ElseIf} $reinstalling == 1
    !insertmacro RemoveShortcut "${link}"
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro UpdateShortcut "$newDesktopLink" $desktopShortcut
!macroend

!macro InitializeInstallOptions
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
  !insertmacro setLinkVars
  StrCpy $desktopShortcut ${BST_CHECKED}
  StrCpy $reinstalling 0
  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
    StrCpy $reinstalling 1
    ${IfNot} ${FileExists} "$oldDesktopLink"
      StrCpy $desktopShortcut ${BST_UNCHECKED}
    ${EndIf}
  ${EndIf}
  ${If} ${isNoDesktopShortcut}
    StrCpy $desktopShortcut ${BST_UNCHECKED}
  ${EndIf}
!macroend

; The UI launches the same package silently. Run before electron-builder
; acquires the installer mutex so the silent child can own that mutex.
!macro preInit
  ${IfNot} ${Silent}
    !insertmacro check64BitAndSetRegView
    !insertmacro InitializeInstallOptions
    InitPluginsDir
    File /oname=$PLUGINSDIR\MyLikeSetupUI.exe "${PROJECT_DIR}\dist\installer-resources\MyLikeSetupUI.exe"
    SectionGetSize 0 $0
    ClearErrors
    ExecWait '"$PLUGINSDIR\MyLikeSetupUI.exe" "$EXEPATH" "$INSTDIR\." "$perUserInstallationFolder\." $desktopShortcut $0 "${APP_GUID}"' $1
    ${If} ${Errors}
      MessageBox MB_ICONSTOP "无法打开 MyLike 安装界面。"
      StrCpy $1 1
    ${EndIf}
    SetErrorLevel $1
    Quit
  ${EndIf}
!macroend

!macro customInit
  !insertmacro InitializeInstallOptions
  ${If} ${Silent}
    Push "$INSTDIR"
    Call ValidateInstallTarget
    Pop $0
    ${If} $0 == 0
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
!macroend
!endif
