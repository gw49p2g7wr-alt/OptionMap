!macro customInit
  # electron-builder 26.x can report a false running-app failure while invoking
  # the beta.5/beta.6 uninstaller during an in-place per-user update.  Keep the
  # existing install in place and let the new package overwrite it after an
  # exact identity, version, location, and process check.
  ReadRegStr $R6 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\86e1842e-b180-5d01-b997-d4a5797998d5" "DisplayVersion"
  ${if} $R6 == "1.1.0-beta.5"
  ${orIf} $R6 == "1.1.0-beta.6"
    ReadRegStr $R7 HKCU "Software\86e1842e-b180-5d01-b997-d4a5797998d5" "InstallLocation"
    StrCpy $R8 "$LOCALAPPDATA\Programs\optionmap"
    ${if} $R7 != $R8
      MessageBox MB_OK|MB_ICONSTOP "The existing OptionMap installation location is not supported by this updater.$\r$\n$R7" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}

    nsExec::Exec '"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""'
    Pop $R9
    ${if} $R9 == 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "OptionMap is still running. Close OptionMap and run this installer again." /SD IDOK
      SetErrorLevel 2
      Quit
    ${elseIf} $R9 != 1
      MessageBox MB_OK|MB_ICONSTOP "OptionMap could not safely verify the existing installation before updating." /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}

    # Removing only these dispatch values prevents the known-broken old
    # uninstaller path.  The install identity and userData remain untouched;
    # registryAddInstallInfo writes fresh values after extraction succeeds.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\86e1842e-b180-5d01-b997-d4a5797998d5" "UninstallString"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\86e1842e-b180-5d01-b997-d4a5797998d5" "QuietUninstallString"
  ${endif}
!macroend

!macro customInstall
  SetOverwrite on
!macroend
