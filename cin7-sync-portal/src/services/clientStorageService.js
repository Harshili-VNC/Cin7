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
    if (!clientId || typeof clientId !== 'string') {
      throw new Error('Invalid client ID provided.');
    }
    const safeClientId = path.basename(clientId);
    return path.join(CLIENTS_STORAGE_ROOT, safeClientId);
  }

  getClientCurrentDir(clientId) {
    return path.join(this.getClientDir(clientId), 'current');
  }

  getClientHistoryDir(clientId) {
    return path.join(this.getClientDir(clientId), 'history');
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

  async initClientStorage(clientId) {
    const currentDir = this.getClientCurrentDir(clientId);
    const historyDir = this.getClientHistoryDir(clientId);

    this.ensureDirectoryExists(currentDir);
    this.ensureDirectoryExists(historyDir);

    const currentFilePath = this.getClientCurrentWorkbookPath(clientId);
    const initialHistoryPath = this.getClientHistoryWorkbookPath(clientId, 'v1.0');
    const masterPath = this.getMasterTemplatePath();

    if (!fs.existsSync(currentFilePath)) {
      console.log(`[STORAGE] Initializing client ${clientId} workbook from master template.`);
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
    const currentFilePath = this.getClientCurrentWorkbookPath(clientId);
    if (!fs.existsSync(currentFilePath)) {
      this.ensureDirectoryExists(this.getClientCurrentDir(clientId));
      this.ensureDirectoryExists(this.getClientHistoryDir(clientId));
      const masterPath = this.getMasterTemplatePath();
      fs.copyFileSync(masterPath, currentFilePath);
      const initialHistory = this.getClientHistoryWorkbookPath(clientId, 'v1.0');
      if (!fs.existsSync(initialHistory)) {
        fs.copyFileSync(masterPath, initialHistory);
      }
    }
    return currentFilePath;
  }

  archiveVersion(clientId, versionId) {
    const currentPath = this.getClientCurrentWorkbookPath(clientId);
    if (!fs.existsSync(currentPath)) {
      this.ensureClientWorkbookExists(clientId);
    }
    const historyPath = this.getClientHistoryWorkbookPath(clientId, versionId);
    this.ensureDirectoryExists(this.getClientHistoryDir(clientId));
    fs.copyFileSync(currentPath, historyPath);
    console.log(`[STORAGE] Archived snapshot for client ${clientId} as ${versionId}`);
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
    const historyDir = this.getClientHistoryDir(clientId);
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