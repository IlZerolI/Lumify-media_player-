$WshShell = New-Object -comObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$Shortcut = $WshShell.CreateShortcut("$DesktopPath\Lumify.lnk")
$Shortcut.TargetPath = "$PSScriptRoot\start_lumify.bat"
$Shortcut.WorkingDirectory = "$PSScriptRoot"
$Shortcut.IconLocation = "%SystemRoot%\System32\shell32.dll,14"
$Shortcut.Description = "Lumify Media Player"
$Shortcut.Save()
Write-Host "Desktop shortcut created: Lumify.lnk"
