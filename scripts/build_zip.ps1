$root = "C:\Users\Harshili Patni\OneDrive - VNC Global Business Edge Pvt Ltd\Desktop\Cin7"
$zipPath = "C:\Users\Harshili Patni\OneDrive - VNC Global Business Edge Pvt Ltd\Desktop\Cin7\Cin7-Project.zip"
$desktopZip = "C:\Users\Harshili Patni\OneDrive - VNC Global Business Edge Pvt Ltd\Desktop\Cin7-Project.zip"

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
if (Test-Path $desktopZip) { Remove-Item $desktopZip -Force }

$tempDir = Join-Path $env:TEMP ("cin7_bundle_" + (Get-Random))
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempDir | Out-Null

$excludeRoot = @('node_modules', '.git', 'Cin7-Project.zip', 'Cin7_Project.zip', 'prevcin7--version')

Get-ChildItem -Path $root | ForEach-Object {
    if ($excludeRoot -notcontains $_.Name -and $_.Name -notlike '*.zip') {
        $dest = Join-Path $tempDir $_.Name
        if ($_.PSIsContainer) {
            robocopy $_.FullName $dest /E /XD node_modules .git /XF *.zip *.tmp /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
        } else {
            Copy-Item $_.FullName $dest -Force
        }
    }
}

$compressFiles = Get-ChildItem -Path $tempDir
Compress-Archive -Path $compressFiles.FullName -DestinationPath $zipPath -CompressionLevel Optimal -Force

Copy-Item $zipPath $desktopZip -Force
Remove-Item $tempDir -Recurse -Force

$file = Get-Item $zipPath
Write-Host "SUCCESS: Created $($file.FullName) (Size: $([math]::Round($file.Length / 1MB, 2)) MB / $($file.Length) bytes)"
Write-Host "SUCCESS: Copied to Desktop -> $desktopZip"
