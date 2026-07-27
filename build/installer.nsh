; ----------------------------------------------------------------------
; Custom NSIS macros for Market Management installer.
;
; Bundles the Microsoft Visual C++ Redistributable (x64) and runs it
; silently during installation so the app works on clean Windows PCs
; without a separate VC++ runtime install.
; ----------------------------------------------------------------------

!macro customInstall
  ; Extract the bundled VC++ Redistributable to the plugins temp directory
  ; and run it silently.
  File /oname=$PLUGINSDIR\vc_redist.x64.exe "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /quiet /norestart' $0
  ; Exit code 0 = success or already installed.
  ; Exit code 1638 = a newer version is already installed (non-fatal).
  ; Treat exit codes 0 and 1638 as OK; warn on other non-zero codes.
  ${If} $0 != 0
  ${AndIf} $0 != 1638
    MessageBox MB_ICONEXCLAMATION|MB_OK \
      "VC++ Redistributable installation returned exit code $0.$\n$\nThe app may fail to start. Please install the Visual C++ Redistributable manually from https://aka.ms/vs/17/release/vc_redist.x64.exe"
  ${EndIf}
!macroend
