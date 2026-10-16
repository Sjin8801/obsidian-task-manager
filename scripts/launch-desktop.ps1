$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
try {
    $electronExecutable = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
    $entryPoint = Join-Path $projectRoot 'dist\desktop\main.cjs'
    if (!(Test-Path -LiteralPath $electronExecutable) -or !(Test-Path -LiteralPath $entryPoint)) {
        throw 'The desktop build is missing. Run npm ci and npm run desktop:build in the project folder.'
    }
    $env:TASK_DESKTOP_DATA = Join-Path $projectRoot '.local\desktop'
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Start-Process -FilePath $electronExecutable -ArgumentList ('"' + $entryPoint + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Obsidian Task Manager') | Out-Null
    exit 1
}
