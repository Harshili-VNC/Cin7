const fs = require('fs');
const path = require('path');

const STORAGE_ROOT = path.join(__dirname, '../../storage');
const MASTER_TEMPLATE_PATH = path.join(STORAGE_ROOT, 'master/Controller_Reporting_Model_v5_Cin7_Actuals.xlsx');
const CLIENTS_STORAGE_ROOT = path.join(STORAGE_ROOT, 'clients');

class ClientStorageService {
  constructor() {
    this.ensureDirectoryExists(STORAGE_ROOT);
    this.ensureDirectoryExists(path.join(STORAGE_ROOT, 'master'));
    this.ensureDirectoryExists(CLIENTS_STORAGE_ROOT);
  }

  ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  validateClientId(clientId) {
    if (!clientId || typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(clientId)) {
      throw new Error(`Invalid clientId: '${clientId}'. Must match allow-list regex ^[a-zA-Z0-9_-]{1,64}$ and contain no path traversal characters.`);
    }
    return clientId;
  }

  getMasterTemplatePath() {
    if (fs.existsSync(MASTER_TEMPLATE_PATH)) {
      return MASTER_TEMPLATE_PATH;
    }
    const fallbackPath = path.join(__dirname, '../../../Controller_Reporting_Model_v5_Cin7_Actuals.xlsx');
    if (fs.existsSync(fallbackPath)) {
      return fallbackPath;
    }
    throw new Error('Master Excel template workbook not found on server.');
  }

  getClientDir(clientId) {
    const safeClientId = this.validateClientId(clientId);
    const clientDir = path.join(CLIENTS_STORAGE_ROOT, safeClientId);
    this.ensureDirectoryExists(clientDir);
    return clientDir;
  }

  getClientCurrentReportsDir(clientId) {
    const dir = path.join(this.getClientDir(clientId), 'current_reports');
    this.ensureDirectoryExists(dir);
    return dir;
  }

  getClientSnapshotsDir(clientId) {
    const dir = path.join(this.getClientDir(clientId), 'snapshots');
    this.ensureDirectoryExists(dir);
    return dir;
  }

  getClientSyncStatePath(clientId) {
    return path.join(this.getClientDir(clientId), 'sync_state.json');
  }

  getClientOrderCacheDir(clientId) {
    const dir = path.join(this.getClientDir(clientId), 'order_cache');
    this.ensureDirectoryExists(dir);
    return dir;
  }

  getClientGoogleSheetsDir(clientId) {
    const dir = path.join(this.getClientDir(clientId), 'google_sheets');
    this.ensureDirectoryExists(dir);
    return dir;
  }

  getClientExportsDir(clientId) {
    const dir = path.join(this.getClientDir(clientId), 'exports');
    this.ensureDirectoryExists(dir);
    return dir;
  }

  getClientCurrentDir(clientId) {
    const dir = path.join(this.getClientDir(clientId), 'current');
    this.ensureDirectoryExists(dir);
    return dir;
  }

  getClientHistoryDir(clientId) {
    const dir = path.join(this.getClientDir(clientId), 'history');
    this.ensureDirectoryExists(dir);
    return dir;
  }

  getClientCurrentWorkbookPath(clientId) {
    const clientDir = this.getClientDir(clientId);
    const currentPath = path.join(this.getClientCurrentDir(clientId), 'reporting.xlsx');
    const resolved = path.resolve(currentPath);
    if (!resolved.startsWith(path.resolve(clientDir))) {
      throw new Error('Unauthorized storage path traversal detected.');
    }
    return resolved;
  }

  getClientHistoryWorkbookPath(clientId, versionId) {
    const clientDir = this.getClientDir(clientId);
    const safeVersion = path.basename(versionId || 'v1.0').replace(/[^a-zA-Z0-9._-]/g, '');
    const versionFileName = safeVersion.endsWith('.xlsx') ? safeVersion : `${safeVersion}.xlsx`;
    const historyPath = path.join(this.getClientHistoryDir(clientId), versionFileName);
    const resolved = path.resolve(historyPath);
    if (!resolved.startsWith(path.resolve(clientDir))) {
      throw new Error('Unauthorized storage path traversal detected.');
    }
    return resolved;
  }

  /**
   * Safe Legacy Data Migration with Explicit Ownership Verification.
   * Only migrates files if client ownership is unambiguously verified in the metadata.
   */
  safeMigrateLegacyClientData(clientId) {
    const safeClientId = this.validateClientId(clientId);
    let migratedCount = 0;

    // 1. Migrate legacy sync_state: storage/sync_state/<clientId>.json -> storage/clients/<clientId>/sync_state.json
    const legacySyncState = path.join(STORAGE_ROOT, 'sync_state', `${safeClientId}.json`);
    const targetSyncState = this.getClientSyncStatePath(safeClientId);

    if (fs.existsSync(legacySyncState) && !fs.existsSync(targetSyncState)) {
      try {
        const raw = fs.readFileSync(legacySyncState, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.clientId === safeClientId) {
          fs.writeFileSync(targetSyncState, raw, 'utf8');
          migratedCount++;
          console.log(`[STORAGE MIGRATION] Verified ownership and migrated sync_state for '${safeClientId}'`);
        } else {
          console.warn(`[STORAGE MIGRATION WARNING] Skipping sync_state migration: metadata clientId (${parsed.clientId}) != target (${safeClientId})`);
        }
      } catch (err) {
        console.warn(`[STORAGE MIGRATION WARNING] Failed parsing legacy sync state for '${safeClientId}':`, err.message);
      }
    }

    // 2. Migrate legacy current_reports: storage/current_reports/<clientId>/ -> storage/clients/<clientId>/current_reports/
    const legacyCurrentDir = path.join(STORAGE_ROOT, 'current_reports', safeClientId);
    const targetCurrentDir = this.getClientCurrentReportsDir(safeClientId);

    if (fs.existsSync(legacyCurrentDir)) {
      const files = fs.readdirSync(legacyCurrentDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const legacyFile = path.join(legacyCurrentDir, file);
        const targetFile = path.join(targetCurrentDir, file);
        if (!fs.existsSync(targetFile)) {
          try {
            const raw = fs.readFileSync(legacyFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.clientId === safeClientId) {
              fs.writeFileSync(targetFile, raw, 'utf8');
              migratedCount++;
              console.log(`[STORAGE MIGRATION] Verified ownership and migrated current_report '${file}' for '${safeClientId}'`);
            } else {
              console.warn(`[STORAGE MIGRATION WARNING] Skipping current_report '${file}' migration: metadata clientId (${parsed.clientId}) != target (${safeClientId})`);
            }
          } catch (err) {
            console.warn(`[STORAGE MIGRATION WARNING] Could not verify ownership of '${file}':`, err.message);
          }
        }
      }
    }

    // 3. Migrate legacy snapshots: storage/snapshots/<clientId>/ -> storage/clients/<clientId>/snapshots/
    const legacySnapshotsDir = path.join(STORAGE_ROOT, 'snapshots', safeClientId);
    const targetSnapshotsDir = this.getClientSnapshotsDir(safeClientId);

    if (fs.existsSync(legacySnapshotsDir)) {
      const files = fs.readdirSync(legacySnapshotsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const legacyFile = path.join(legacySnapshotsDir, file);
        const targetFile = path.join(targetSnapshotsDir, file);
        if (!fs.existsSync(targetFile)) {
          try {
            const raw = fs.readFileSync(legacyFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.clientId === safeClientId) {
              fs.writeFileSync(targetFile, raw, 'utf8');
              migratedCount++;
              console.log(`[STORAGE MIGRATION] Verified ownership and migrated snapshot '${file}' for '${safeClientId}'`);
            } else {
              console.warn(`[STORAGE MIGRATION WARNING] Skipping snapshot '${file}' migration: metadata clientId (${parsed.clientId}) != target (${safeClientId})`);
            }
          } catch (err) {
            console.warn(`[STORAGE MIGRATION WARNING] Could not verify ownership of snapshot '${file}':`, err.message);
          }
        }
      }
    }

    // 4. Migrate legacy order_cache: storage/order_cache/<clientId>/ -> storage/clients/<clientId>/order_cache/
    const legacyOrderCacheDir = path.join(STORAGE_ROOT, 'order_cache', safeClientId);
    const targetOrderCacheDir = this.getClientOrderCacheDir(safeClientId);

    if (fs.existsSync(legacyOrderCacheDir)) {
      const files = fs.readdirSync(legacyOrderCacheDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const legacyFile = path.join(legacyOrderCacheDir, file);
        const targetFile = path.join(targetOrderCacheDir, file);
        if (!fs.existsSync(targetFile)) {
          try {
            fs.copyFileSync(legacyFile, targetFile);
            migratedCount++;
          } catch (_) {}
        }
      }
    }

    return { success: true, migratedCount };
  }

  async initClientStorage(clientId) {
    const safeClientId = this.validateClientId(clientId);
    const currentDir = this.getClientCurrentDir(safeClientId);
    const historyDir = this.getClientHistoryDir(safeClientId);

    this.ensureDirectoryExists(currentDir);
    this.ensureDirectoryExists(historyDir);
    this.ensureDirectoryExists(this.getClientCurrentReportsDir(safeClientId));
    this.ensureDirectoryExists(this.getClientSnapshotsDir(safeClientId));
    this.ensureDirectoryExists(this.getClientOrderCacheDir(safeClientId));
    this.ensureDirectoryExists(this.getClientGoogleSheetsDir(safeClientId));
    this.ensureDirectoryExists(this.getClientExportsDir(safeClientId));

    // Attempt safe migration of legacy assets
    this.safeMigrateLegacyClientData(safeClientId);

    const currentFilePath = this.getClientCurrentWorkbookPath(safeClientId);
    const initialHistoryPath = this.getClientHistoryWorkbookPath(safeClientId, 'v1.0');
    const masterPath = this.getMasterTemplatePath();

    if (!fs.existsSync(currentFilePath)) {
      console.log(`[STORAGE] Initializing client ${safeClientId} workbook from master template.`);
      fs.copyFileSync(masterPath, currentFilePath);
    }

    if (!fs.existsSync(initialHistoryPath)) {
      fs.copyFileSync(masterPath, initialHistoryPath);
    }

    return {
      currentPath: currentFilePath,
      initialHistoryPath,
      currentVersion: 'v1.0'
    };
  }

  ensureClientWorkbookExists(clientId) {
    const safeClientId = this.validateClientId(clientId);
    const currentFilePath = this.getClientCurrentWorkbookPath(safeClientId);
    if (!fs.existsSync(currentFilePath)) {
      this.ensureDirectoryExists(this.getClientCurrentDir(safeClientId));
      this.ensureDirectoryExists(this.getClientHistoryDir(safeClientId));
      const masterPath = this.getMasterTemplatePath();
      fs.copyFileSync(masterPath, currentFilePath);
      const initialHistory = this.getClientHistoryWorkbookPath(safeClientId, 'v1.0');
      if (!fs.existsSync(initialHistory)) {
        fs.copyFileSync(masterPath, initialHistory);
      }
    }
    return currentFilePath;
  }

  archiveVersion(clientId, versionId) {
    const safeClientId = this.validateClientId(clientId);
    const currentPath = this.getClientCurrentWorkbookPath(safeClientId);
    if (!fs.existsSync(currentPath)) {
      this.ensureClientWorkbookExists(safeClientId);
    }
    const historyPath = this.getClientHistoryWorkbookPath(safeClientId, versionId);
    this.ensureDirectoryExists(this.getClientHistoryDir(safeClientId));
    fs.copyFileSync(currentPath, historyPath);
    console.log(`[STORAGE] Archived snapshot for client ${safeClientId} as ${versionId}`);
    return historyPath;
  }

  calculateNextVersion(currentVersion) {
    if (!currentVersion || typeof currentVersion !== 'string') {
      return 'v2.0';
    }
    const match = currentVersion.match(/v?(\d+)(\.(\d+))?/i);
    if (match) {
      const major = parseInt(match[1], 10);
      return `v${major + 1}.0`;
    }
    return 'v2.0';
  }

  listClientHistoryVersions(clientId) {
    const safeClientId = this.validateClientId(clientId);
    const historyDir = this.getClientHistoryDir(safeClientId);
    if (!fs.existsSync(historyDir)) {
      return [];
    }
    const files = fs.readdirSync(historyDir);
    return files
      .filter(f => f.endsWith('.xlsx'))
      .map(f => {
        const filePath = path.join(historyDir, f);
        const stats = fs.statSync(filePath);
        const versionId = f.replace(/\.xlsx$/i, '');
        return {
          versionId,
          fileName: f,
          sizeBytes: stats.size,
          createdAt: stats.birthtime || stats.mtime,
          modifiedAt: stats.mtime
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  }
}

module.exports = new ClientStorageService();