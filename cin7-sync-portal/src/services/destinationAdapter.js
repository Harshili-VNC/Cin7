/**
 * Abstract Base Class for Destination Adapters (Excel Online / Google Sheets)
 */
class DestinationAdapter {
  constructor(clientId, userOAuthAccount) {
    this.clientId = clientId;
    this.userOAuthAccount = userOAuthAccount;
  }

  /**
   * Resolves or creates client destination file
   */
  async getOrCreateDestination() {
    throw new Error('getOrCreateDestination() must be implemented by subclass');
  }

  /**
   * Syncs Sales Dataset into canonical sheet
   */
  async syncSales(salesData) {
    throw new Error('syncSales() must be implemented by subclass');
  }

  /**
   * Syncs Inventory Dataset into canonical sheet
   */
  async syncInventory(inventoryData) {
    throw new Error('syncInventory() must be implemented by subclass');
  }

  /**
   * Syncs Purchase Orders Dataset into canonical sheet
   */
  async syncPurchaseOrders(purchaseData) {
    throw new Error('syncPurchaseOrders() must be implemented by subclass');
  }

  /**
   * Updates Sync Log Sheet
   */
  async updateSyncLog(logEntry) {
    throw new Error('updateSyncLog() must be implemented by subclass');
  }
}

module.exports = DestinationAdapter;
