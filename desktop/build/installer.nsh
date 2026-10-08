; Neubit VMS - NSIS hooks for electron-builder.
;
; The installer lays down two things: the desktop app, and the SERVER - the
; native appliance payload in resources\server (neubitvms-svc.exe and what it
; supervises), registered as the Windows Service "NeubitVMS" by
; resources\server\scripts\install-appliance.ps1.
; See docs/WINDOWS_NATIVE_APPLIANCE.md. A workstation that only needs the
; console uses the Portable exe, which has no server.
;
; The shape follows the Neubit NVR's installer, which learned each of these on
; real machines:
;   * stop the service BEFORE extraction (customInit), or the running server
;     holds its own files and an upgrade cannot replace them;
;   * an upgrade is NOT an uninstall: the old uninstaller runs with --updated and
;     must not tear the service down or touch data;
;   * the uninstall scripts are staged to $TEMP first (customUnInit), because
;     $INSTDIR is gone by the time customUnInstall runs;
;   * data is kept unless the operator says otherwise, and silent mode says no;
;   * every MessageBox has /SD, so a silent install never waits for a click.
;
; PowerShell is the 64-bit one (Sysnative): this installer is 32-bit, and a
; 32-bit PowerShell is handed SysWOW64 for System32 and WOW6432Node for HKLM.

!define NEUBIT_REG_KEY "Software\Neubit\VMS"
!define SERVER_STAGE "$TEMP\NeubitVMSUninstall"
!define PS64 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"

; Only the uninstaller reads it. makensis runs with -WX, so declared in the
; installer's own pass it is an "unreferenced variable" warning: a failed build.
!ifdef BUILD_UNINSTALLER
  Var NeubitDataRoot
!endif

!macro customInit
  ; Best effort and silent: no service, or no permission, falls through to
  ; install-appliance.ps1, which reports the specific problem properly.
  nsExec::ExecToLog `"${PS64}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { Stop-Service -Name 'NeubitVMS' -Force -ErrorAction Stop; (Get-Service -Name 'NeubitVMS').WaitForStatus('Stopped',(New-TimeSpan -Seconds 180)) } catch { }"`
  Pop $0
!macroend

; electron-builder's default pops a MessageBox with no /SD when the previous
; uninstaller fails; that hangs a silent upgrade. Same decision, auto-answered.
!macro customUnInstallCheck
  IfErrors 0 +3
    DetailPrint "Could not launch the previous version's uninstaller; continuing."
    Return
  ${If} $R0 != 0
    DetailPrint "The previous version's uninstaller failed (code $R0)."
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customInstall
  DetailPrint "Setting up the Neubit VMS server (first install creates the database; this can take a few minutes)..."
  ; Output goes to the details view: Start-Transcript does not capture a native
  ; command's output, so this is what puts a failure where a human sees it.
  nsExec::ExecToLog `"${PS64}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\server\scripts\install-appliance.ps1" -ServerDir "$INSTDIR\resources\server"`
  Pop $0
  ${If} $0 != 0
    ; Not an abort: the app is installed and can reach a server elsewhere.
    MessageBox MB_ICONEXCLAMATION|MB_OK \
      "The Neubit VMS app was installed, but the server did not finish setting up (code $0).$\r$\n$\r$\n\
The reason is in:$\r$\n  %ProgramData%\Neubit\vms-install.log$\r$\n$\r$\n\
To retry, from an elevated PowerShell:$\r$\n\
  $INSTDIR\resources\server\scripts\install-appliance.ps1" \
      /SD IDOK
    SetErrorLevel 3
  ${EndIf}
!macroend

!macro customUnInit
  ${ifNot} ${isUpdated}
    ReadRegStr $NeubitDataRoot HKLM "${NEUBIT_REG_KEY}" "DataRoot"
    CreateDirectory "${SERVER_STAGE}"
    CopyFiles /SILENT "$INSTDIR\resources\server\scripts\uninstall-appliance.ps1" "${SERVER_STAGE}"
    CopyFiles /SILENT "$INSTDIR\resources\server\neubitvms-svc.exe" "${SERVER_STAGE}"
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Removing the Neubit VMS server..."
    StrCpy $R0 "%ProgramData%\Neubit\VMS"
    ${If} $NeubitDataRoot != ""
      StrCpy $R0 $NeubitDataRoot
    ${EndIf}

    ; KEPT BY DEFAULT: an uninstall is more often a move to new hardware than a
    ; decision to destroy a security system's database.
    MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 \
      "Also delete the Neubit VMS database and files?$\r$\n$\r$\n\
They are in:$\r$\n  $R0$\r$\n$\r$\n\
Choosing No keeps them, and reinstalling later picks the existing users, sites, \
cameras and settings back up.$\r$\n$\r$\n\
Choosing Yes deletes them permanently. This cannot be undone." \
      /SD IDNO IDYES removeData IDNO keepData

    removeData:
      nsExec::ExecToLog `"${PS64}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${SERVER_STAGE}\uninstall-appliance.ps1" -ServerDir "${SERVER_STAGE}" -Root "$R0" -RemoveData -Confirm`
      Pop $0
      Goto uninstallDone

    keepData:
      nsExec::ExecToLog `"${PS64}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${SERVER_STAGE}\uninstall-appliance.ps1" -ServerDir "${SERVER_STAGE}" -Root "$R0"`
      Pop $0

    uninstallDone:
      ${If} $0 != 0
        MessageBox MB_ICONEXCLAMATION|MB_OK \
          "The Neubit VMS service could not be fully removed (code $0).$\r$\n$\r$\n\
To finish by hand, from an elevated PowerShell:$\r$\n  sc.exe stop NeubitVMS$\r$\n  sc.exe delete NeubitVMS" \
          /SD IDOK
      ${EndIf}

    ; The service held its files open; now it is gone, sweep what is left. Leave
    ; $INSTDIR as the working directory first, or Windows keeps the empty folder.
    SetOutPath "$TEMP"
    RMDir /r "$INSTDIR"
    RMDir /r "${SERVER_STAGE}"
  ${endIf}
!macroend
