$portalDir = "C:\Users\Harshili Patni\OneDrive - VNC Global Business Edge Pvt Ltd\Desktop\Cin7\cin7-sync-portal"
$dbStorePath = Join-Path $portalDir "src\db\portal_db_store.json"
$storageDir = Join-Path $portalDir "storage"

# 1. Reset portal_db_store.json to clean catalog state
$cleanDb = @{
    clients = @{}
    users = @{}
    oauth_accounts = @{}
    client_preferences = @{}
    cin7_connections = @{}
    destination_files = @{}
    client_workbooks = @{}
    sync_runs = @{}
    sync_logs = @()
    report_snapshots = @{}
    audit_logs = @()
    plans = @{
        "plan-starter" = @{
            id = "plan-starter"
            name = "Starter"
            code = "STARTER"
            description = "Essential Cin7 reporting & reconciliation for solo controllers"
            price = 49
            currency = "USD"
            billing_interval = "monthly"
            is_active = $true
            features_json = '{"cin7_sync":true,"google_sheets":true,"sales_reports":true,"inventory_reports":true}'
            limits_json = '{"max_users":1,"max_syncs_per_month":30,"max_cin7_connections":1,"max_google_sheets":1,"max_storage":5,"max_report_history_days":30}'
            created_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            updated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        }
        "plan-professional" = @{
            id = "plan-professional"
            name = "Professional"
            code = "PROFESSIONAL"
            description = "Full-suite controller automation, multi-user collaboration & scheduled sync"
            price = 149
            currency = "USD"
            billing_interval = "monthly"
            is_active = $true
            features_json = '{"cin7_sync":true,"google_sheets":true,"sales_reports":true,"purchase_reports":true,"inventory_reports":true,"advanced_reports":true,"report_history":true,"reconciliation":true,"scheduled_sync":true,"multiple_users":true,"advanced_settings":true}'
            limits_json = '{"max_users":10,"max_syncs_per_month":500,"max_cin7_connections":5,"max_google_sheets":5,"max_storage":25,"max_report_history_days":365}'
            created_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            updated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        }
        "plan-enterprise" = @{
            id = "plan-enterprise"
            name = "Enterprise"
            code = "ENTERPRISE"
            description = "High-throughput consolidation, unlimited connections & priority support"
            price = 399
            currency = "USD"
            billing_interval = "monthly"
            is_active = $true
            features_json = '{"cin7_sync":true,"google_sheets":true,"sales_reports":true,"purchase_reports":true,"inventory_reports":true,"advanced_reports":true,"report_history":true,"reconciliation":true,"scheduled_sync":true,"multiple_users":true,"advanced_settings":true,"api_access":true,"priority_support":true}'
            limits_json = '{"max_users":50,"max_syncs_per_month":5000,"max_cin7_connections":999,"max_google_sheets":999,"max_storage":100,"max_report_history_days":3650}'
            created_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            updated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        }
    }
    subscriptions = @{}
    billing_events = @()
}

$cleanDb | ConvertTo-Json -Depth 10 | Set-Content -Path $dbStorePath -Encoding UTF8
Write-Host "Database reset to clean state: $dbStorePath"

# 2. Clean storage folders except master/
$subdirs = @('clients', 'current_reports', 'snapshots', 'sync_state', 'order_cache', 'google_sheets', 'excel_files')
foreach ($sub in $subdirs) {
    $targetDir = Join-Path $storageDir $sub
    if (Test-Path $targetDir) {
        Get-ChildItem -Path $targetDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Storage subdirectories purged. Master reporting model preserved:"
Get-ChildItem -Path (Join-Path $storageDir "master") | Select-Object Name, Length
