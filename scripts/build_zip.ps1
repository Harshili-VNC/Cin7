$root = "C:\Users\Harshili Patni\OneDrive - VNC Global Business Edge Pvt Ltd\Desktop\Cin7"
$zipPath = "C:\Users\Harshili Patni\OneDrive - VNC Global Business Edge Pvt Ltd\Desktop\Cin7\Cin7-Project.zip"

if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

$items = Get-ChildItem -Path $root | Where-Object { 
    $_.Name -ne 'node_modules' -and 
    $_.Name -ne '.git' -and 
    $_.Name -ne 'Cin7-Project.zip' -and
    $_.Name -ne 'prevcin7--version'
}

Compress-Archive -Path $items.FullName -DestinationPath $zipPath -CompressionLevel Optimal -Force

$file = Get-Item $zipPath
Write-Host "SUCCESS: Created $($file.FullName) (Size: $([math]::Round($file.Length / 1MB, 2)) MB / $($file.Length) bytes)"
