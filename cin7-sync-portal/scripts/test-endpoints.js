const axios = require('axios');

async function testEndpoints() {
  console.log('Testing endpoints...');
  try {
    const r1 = await axios.get('http://localhost:8000/api/health');
    console.log('Backend /api/health: OK (Status 200) ->', r1.data);
  } catch (e) {
    console.error('Backend health error:', e.message);
  }

  try {
    const r2 = await axios.get('http://localhost:3000/');
    console.log('React Vite Frontend (port 3000): OK (Status 200)');
  } catch (e) {
    console.error('Frontend error:', e.message);
  }

  try {
    const r3 = await axios.get('http://localhost:3000/api/health');
    console.log('Frontend Proxy to Backend (/api/health): OK (Status 200) ->', r3.data);
  } catch (e) {
    console.error('Proxy error:', e.message);
  }
}

testEndpoints().catch(console.error);
