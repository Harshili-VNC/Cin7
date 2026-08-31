$excel = New-Object -ComObject Excel.Application
$excel.Visible = $true
$excel.DisplayAlerts = $false

Write-Host "Opening workbooks natively in Microsoft Excel desktop..."

$file1 = "c:\Users\Harshili Patni\OneDrive - VNC Global Business Edge Pvt Ltd\Desktop\Microsoft\Controller_Reporting_Client_Populated.xlsx"
if (Test-Path $file1) {
    Write-Host "Opening $file1 in Excel..."
    $wb1 = $excel.Workbooks.Open($file1)
    $excel.CalculateFull()
    $wb1.Save()
    $wb1.Close($false)
    Write-Host "Successfully recalculated and saved $file1 in Excel."
}

$file2 = "c:\Users\Harshili Patni\OneDrive - VNC Global Business Edge Pvt Ltd\Desktop\Microsoft\Controller_Reporting_Master_Template_Updated.xlsx"
if (Test-Path $file2) {
    Write-Host "Opening $file2 in Excel..."
    $wb2 = $excel.Workbooks.Open($file2)
    $excel.CalculateFull()
    $wb2.Save()
    $wb2.Close($false)
    Write-Host "Successfully recalculated and saved $file2 in Excel."
}

$excel.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
Write-Host "Excel processing complete."
