# One-time setup: registers a custom "ipojisyncbot://" link handler on this
# Windows account so the portal's "Run local sync bot" button can launch
# launch.bat directly from the browser - the same mechanism "mailto:" links
# open your email client, or "vscode://" links open VS Code. Per-user
# (HKEY_CURRENT_USER), no admin rights required.
#
# Run this once:
#   powershell -ExecutionPolicy Bypass -File register-protocol.ps1
#
# Safe to re-run any time (e.g. after moving this folder) - it just
# overwrites the same registry keys with the current path.
#
# Plain ASCII only in this file, deliberately - Windows PowerShell 5.1
# misreads non-ASCII characters (an em dash broke it here originally) in a
# .ps1 file that doesn't have a UTF-8 BOM, corrupting the parser with a
# "missing string terminator" error that has nothing to do with the actual
# typo. Confirmed live against this exact file.

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launchBat = Join-Path $scriptDir 'launch.bat'

if (-not (Test-Path $launchBat)) {
    Write-Error "launch.bat not found at $launchBat - run this script from inside scripts/ipoji-sync-bot/."
    exit 1
}

$protocolKey = 'HKCU:\Software\Classes\ipojisyncbot'
New-Item -Path $protocolKey -Force | Out-Null
Set-ItemProperty -Path $protocolKey -Name '(Default)' -Value 'URL:ipoji Sync Bot Protocol'
Set-ItemProperty -Path $protocolKey -Name 'URL Protocol' -Value ''

$commandKey = "$protocolKey\shell\open\command"
New-Item -Path $commandKey -Force | Out-Null
# Points directly at launch.bat - .bat files are natively executable via
# Windows' own file association (same as double-clicking one), no cmd.exe
# wrapper needed. Verified live: a 'cmd.exe /c ""launch.bat""' wrapper form
# runs fine invoked directly, but silently fails when Windows launches it
# via ShellExecute (which a browser's custom-protocol link goes through) -
# an extra layer of quotes gets eaten in that path specifically. This
# simpler form was confirmed working through an actual ShellExecute-style
# invocation, not just a direct command-line run.
#
# The trailing "%1" is Windows' own placeholder for the invoked URL
# (e.g. ipojisyncbot://run) - launch.bat doesn't use it for anything, but
# the shell\open\command convention expects it present.
$command = '"' + $launchBat + '" "%1"'
Set-ItemProperty -Path $commandKey -Name '(Default)' -Value $command

Write-Host "Registered ipojisyncbot:// -> $launchBat"
Write-Host ""
Write-Host "Test it without the browser first:"
Write-Host "  Win+R, type: ipojisyncbot://run"
Write-Host "(Windows may ask once which app should open ipojisyncbot links -- pick this, and you can tell it to remember the choice.)"
