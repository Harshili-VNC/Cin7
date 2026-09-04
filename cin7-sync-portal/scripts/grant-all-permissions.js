const GoogleSheetsAdapter = require('../src/services/googleSheetsAdapter');

async function grantPermissions() {
  const adapter = new GoogleSheetsAdapter('client-vnc-master');
  const { drive } = await adapter.getGoogleClients();

  // List recent generated spreadsheets
  const res = await drive.files.list({
    q: "name contains 'Controller Reporting - Sync -'",
    pageSize: 10,
    fields: 'files(id, name, webViewLink)'
  });

  console.log(`Found ${res.data.files.length} recent spreadsheets. Updating permissions...`);

  for (const f of res.data.files) {
    try {
      await drive.permissions.create({
        fileId: f.id,
        requestBody: {
          role: 'reader',
          type: 'anyone'
        }
      });
      console.log(`✓ Granted anyone-with-link access to: ${f.name} (${f.id})`);
    } catch (e) {
      console.log(`Notice for ${f.id}:`, e.message);
    }
  }

  // Also ensure Master Template is shared
  try {
    await drive.permissions.create({
      fileId: '1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q',
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });
    console.log(`✓ Granted anyone-with-link access to Master Template (1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q)`);
  } catch (e) {
    console.log(`Master template permission notice:`, e.message);
  }
}

grantPermissions().catch(console.error);
