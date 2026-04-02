# close-tab.ps1 — Close a Windows Terminal tab by index using Ctrl+Shift+W
# Usage: .\close-tab.ps1 -TabIndex 3
#        .\close-tab.ps1 -TabIndex 5,4,3    # close multiple (highest first)
#        .\close-tab.ps1 -TabIndex 3 -Window PinchCord

param(
    [Parameter(Mandatory)][int[]]$TabIndex,
    [string]$Window = "PinchCord"
)

Add-Type -AssemblyName System.Windows.Forms
$wshell = New-Object -ComObject WScript.Shell

# Sort descending — close highest index first to avoid index shifting
$sorted = $TabIndex | Sort-Object -Descending

foreach ($i in $sorted) {
    Write-Host "Closing tab $i..." -ForegroundColor Yellow

    wt -w $Window focus-tab -t $i
    Start-Sleep -Milliseconds 400

    $wshell.AppActivate($Window) | Out-Null
    Start-Sleep -Milliseconds 300

    [System.Windows.Forms.SendKeys]::SendWait("^+w")   # Ctrl+Shift+W
    Start-Sleep -Seconds 1

    Write-Host "  Tab $i close sent" -ForegroundColor Green
}

Write-Host "Done. Ask Sam to confirm tabs closed." -ForegroundColor Cyan
