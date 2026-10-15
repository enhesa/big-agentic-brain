: << 'CMDBLOCK'
@echo off
REM Cross-platform wrapper for bab-headers.sh (headersHelper).
REM Windows: cmd.exe runs this part, finds Git's sh.exe and runs the .sh.
REM Unix: sh runs the rest of the file below CMDBLOCK ("<<" opens a here-doc that is skipped).
REM Usage: bab-headers.cmd <absolute data dir>
setlocal
set "SH="
REM 1. The bash Claude Code itself uses, if the user pinned one.
if defined CLAUDE_CODE_GIT_BASH_PATH if exist "%CLAUDE_CODE_GIT_BASH_PATH%" set "SH=%CLAUDE_CODE_GIT_BASH_PATH%"
REM 2. Standard Git for Windows locations.
if not defined SH if exist "%ProgramFiles%\Git\bin\sh.exe" set "SH=%ProgramFiles%\Git\bin\sh.exe"
if not defined SH if exist "%ProgramFiles(x86)%\Git\bin\sh.exe" set "SH=%ProgramFiles(x86)%\Git\bin\sh.exe"
if not defined SH if exist "%LOCALAPPDATA%\Programs\Git\bin\sh.exe" set "SH=%LOCALAPPDATA%\Programs\Git\bin\sh.exe"
REM 3. From git on PATH: X\cmd\git.exe -> X\bin\sh.exe.
REM The PATH lookups skip WSL's bash.exe (System32, WindowsApps): it cannot run this.
if not defined SH for /f "delims=" %%I in ('where git 2^>nul ^| findstr /v /i "system32 windowsapps"') do if not defined SH if exist "%%~dpI..\bin\sh.exe" set "SH=%%~dpI..\bin\sh.exe"
REM 4. sh or bash on PATH.
if not defined SH for /f "delims=" %%I in ('where sh 2^>nul ^| findstr /v /i "system32 windowsapps"') do if not defined SH set "SH=%%I"
if not defined SH for /f "delims=" %%I in ('where bash 2^>nul ^| findstr /v /i "system32 windowsapps"') do if not defined SH set "SH=%%I"
if not defined SH echo {"X-Bab-Device-Error":"no-shell"}& exit /b 0
REM (A "_" sentinel keeps this safe for an empty arg.)
REM A trailing backslash would turn the closing quote into an escaped quote.
set "D=%~1_"
if "%D:~-2%"=="\_" (set "D=%D:~0,-2%") else set "D=%D:~0,-1%"
"%SH%" "%~dp0bab-headers.sh" "%D%"
exit /b 0
CMDBLOCK

exec sh "$(dirname "$0")/bab-headers.sh" "$@"
