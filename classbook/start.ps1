<#
Start classbook on Windows.

    .\start.ps1                  this PC at http://127.0.0.1:8000,
                                 phones at https://<this-pc-ip>:8443
    .\start.ps1 -NoHttps         this PC only; nothing listens on the network
    .\start.ps1 -Port 8080 -HttpsPort 9443

Or double-click start.bat, which runs this script without changing
PowerShell's script policy.

What is missing is installed first - after asking:
  1. pixi, which installs Python and the packages into this folder
     (per user, no admin rights; https://pixi.sh)
  2. the environment: Python, the packages and the headless Chromium for
     the PDFs (a few hundred MB in .pixi\)
The certificate for the phones is made by the server itself on first start.

Ctrl+C stops the server.
#>
param(
    [int]$Port = 8000,
    [int]$HttpsPort = 8443,
    [switch]$NoHttps,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
# Console output in UTF-8: the server's messages contain characters like "-".
$env:PYTHONUTF8 = '1'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if ($Help) {
    Get-Content -LiteralPath $PSCommandPath -TotalCount 22 | Select-Object -Skip 1 -First 20
    exit 0
}

# Ask a yes/no question; anything but yes is no. Without a console to ask
# (started from a script, say) the answer is no, and nothing gets installed.
function Ask([string]$Question) {
    if ([Console]::IsInputRedirected -or -not [Environment]::UserInteractive) { return $false }
    $reply = Read-Host "$Question [y/N]"
    return $reply -match '^\s*(y|yes|j|ja)\s*$'
}

function Stop-WithMessage([string]$Message) {
    Write-Host $Message -ForegroundColor Yellow
    exit 1
}

# --- pixi: the tool that installs Python and everything classbook needs ------
# Installed per user into %USERPROFILE%\.pixi; a console opened before the
# install may not have it on its PATH yet.
$pixiBin = Join-Path $env:USERPROFILE '.pixi\bin'
if (Test-Path -LiteralPath (Join-Path $pixiBin 'pixi.exe')) { $env:PATH = "$pixiBin;$env:PATH" }
if (-not (Get-Command pixi -ErrorAction SilentlyContinue)) {
    Write-Host 'classbook needs pixi, which installs Python and the packages it uses'
    Write-Host 'into this folder (nothing system-wide; https://pixi.sh).'
    if (Ask 'pixi is not installed. Install it now?') {
        Invoke-RestMethod -UseBasicParsing -Uri 'https://pixi.sh/install.ps1' | Invoke-Expression
        $env:PATH = "$pixiBin;$env:PATH"
        if (-not (Get-Command pixi -ErrorAction SilentlyContinue)) {
            Stop-WithMessage 'pixi did not install - see https://pixi.sh for other ways.'
        }
    } else {
        Stop-WithMessage "Not started. Install pixi yourself with:`n  powershell -ExecutionPolicy ByPass -c `"irm -useb https://pixi.sh/install.ps1 | iex`""
    }
}

# --- the environment: Python and the packages, in .pixi\ ---------------------
if (-not (Test-Path -LiteralPath '.pixi\envs\default\python.exe')) {
    Write-Host 'The environment is not installed yet: Python and the packages classbook'
    Write-Host 'uses (a few hundred MB in .pixi\), plus the headless Chromium for PDFs.'
    if (Ask 'Install it now?') {
        & pixi install
        if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'The environment could not be installed (see above).' }
        & pixi run postinstall
        if ($LASTEXITCODE -ne 0) { Write-Host 'Chromium (for PDFs) did not install; everything else works. Retry: pixi run postinstall' -ForegroundColor Yellow }
    } else {
        Stop-WithMessage 'Not started. Install it yourself with:  pixi install; pixi run postinstall'
    }
}

# --- the port ------------------------------------------------------------------
# Only a listener counts: a browser tab still holding a connection is not a server.
$busy = $null
try { $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop } catch { $busy = $null }
if ($busy) { Stop-WithMessage "Port $Port is already in use - is classbook already running?" }

if (-not $NoHttps) {
    Write-Host ''
    Write-Host 'If Windows asks whether Python may communicate on networks: allow it on'
    Write-Host 'private networks - the phones need that. (Choose -NoHttps for this PC only.)'
}

# --- open the browser once the server answers ----------------------------------
$url = "http://127.0.0.1:$Port"
Start-Job -ArgumentList $url -ScriptBlock {
    param($u)
    for ($i = 0; $i -lt 120; $i++) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$u/manifest.webmanifest" -TimeoutSec 2 | Out-Null
            Start-Process $u
            return
        } catch { Start-Sleep -Milliseconds 500 }
    }
} | Out-Null

# --- the server, in this window (Ctrl+C stops it) ------------------------------
$serveArgs = @('run', 'python', '-m', 'app.serve', '--port', $Port, '--https-port', $HttpsPort)
if ($NoHttps) { $serveArgs += '--no-https' }
& pixi @serveArgs
exit $LASTEXITCODE
