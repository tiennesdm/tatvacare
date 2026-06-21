// Use engine's HTTP/JSON wire (port 8130) to verify DB state
import http from 'node:http';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: 8130, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000
    });
    let buf = '';
    req.on('response', (res) => { res.on('data', c => buf += c); res.on('end', () => resolve(buf)); });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

const r = await post('/query', { sql: `SELECT phone, password_hash FROM doctors WHERE phone = '+919876500001'` });
console.log('engine HTTP/JSON response:', r);
process.exit(0);
