/**
 * Per-Client Concurrency Lock Service (Mutex)
 * Prevents concurrent syncs for the SAME client from corrupting state,
 * while allowing DIFFERENT clients to sync completely in parallel.
 */

class LockService {
  constructor() {
    // Map<clientId, { runId, acquiredAt, timeoutHandle }>
    this.activeLocks = new Map();
    this.STALE_LOCK_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes max lock duration for large initial syncs
  }

  validateClientId(clientId) {
    if (!clientId || typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(clientId)) {
      throw new Error(`Invalid clientId: '${clientId}'. Must match ^[a-zA-Z0-9_-]{1,64}$`);
    }
    return clientId;
  }

  /**
   * Refreshes the acquiredAt timestamp of an active lock to keep it alive during active background sync.
   * @param {string} clientId
   * @param {string} runId
   */
  touchLock(clientId, runId) {
    try {
      const safeClientId = this.validateClientId(clientId);
      if (this.activeLocks.has(safeClientId)) {
        const existing = this.activeLocks.get(safeClientId);
        if (!runId || existing.runId === runId) {
          existing.acquiredAt = Date.now();
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * Attempts to acquire a sync lock for a specific client.
   * @param {string} clientId
   * @param {string} runId
   * @returns {{ acquired: boolean, reason?: string, currentLock?: object }}
   */
  acquireLock(clientId, runId) {
    const safeClientId = this.validateClientId(clientId);
    const now = Date.now();

    if (this.activeLocks.has(safeClientId)) {
      const existing = this.activeLocks.get(safeClientId);

      // Check for stale lock
      if (now - existing.acquiredAt > this.STALE_LOCK_TIMEOUT_MS) {
        console.warn(`[LOCK] Auto-releasing stale lock for client '${safeClientId}' (held by ${existing.runId} for >10m)`);
        this.releaseLock(safeClientId, existing.runId);
      } else if (existing.runId !== runId) {
        return {
          acquired: false,
          reason: `Sync already in progress for client '${safeClientId}' (run ID: ${existing.runId}, started ${Math.round((now - existing.acquiredAt) / 1000)}s ago)`,
          currentLock: existing
        };
      }
    }

    const lockData = {
      clientId: safeClientId,
      runId,
      acquiredAt: now,
      acquiredAtIso: new Date(now).toISOString()
    };

    this.activeLocks.set(safeClientId, lockData);
    console.log(`[LOCK] Acquired lock for client '${safeClientId}' (Run: ${runId})`);

    return { acquired: true, lock: lockData };
  }

  /**
   * Releases the sync lock for a specific client if owned by runId.
   * @param {string} clientId
   * @param {string} runId
   */
  releaseLock(clientId, runId = null) {
    try {
      const safeClientId = this.validateClientId(clientId);
      if (!this.activeLocks.has(safeClientId)) return true;

      const existing = this.activeLocks.get(safeClientId);
      if (!runId || existing.runId === runId) {
        this.activeLocks.delete(safeClientId);
        console.log(`[LOCK] Released lock for client '${safeClientId}' (Run: ${runId || existing.runId})`);
        return true;
      }

      console.warn(`[LOCK] Refused to release lock for '${safeClientId}' owned by ${existing.runId} with mismatched runId ${runId}`);
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * Checks if a client is currently locked.
   * @param {string} clientId
   * @returns {boolean}
   */
  isLocked(clientId) {
    try {
      const safeClientId = this.validateClientId(clientId);
      return this.activeLocks.has(safeClientId);
    } catch (e) {
      return false;
    }
  }

  /**
   * Gets lock info for a client.
   * @param {string} clientId
   */
  getLockInfo(clientId) {
    try {
      const safeClientId = this.validateClientId(clientId);
      return this.activeLocks.get(safeClientId) || null;
    } catch (e) {
      return null;
    }
  }
}

module.exports = new LockService();
