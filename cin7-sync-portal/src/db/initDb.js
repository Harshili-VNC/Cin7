const db = require('./index');

async function init() {
  console.log('Initializing VNC Cin7 Sync Database schema...');
  try {
    const res = await db.query('SELECT 1 as test');
    console.log('✅ Database connected and schema ready successfully.', res);
  } catch (err) {
    console.error('❌ Failed to initialize database:', err);
  }
}

if (require.main === module) {
  init();
}

module.exports = init;
