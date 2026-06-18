const http = require('http');
const BASE = 'http://localhost:3000';
function get(p) {
  return new Promise(r => http.get(BASE + p, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => r({ status: res.statusCode, body: d }));
  }));
}
(async () => {
  const r = await get('/api/push/channels?pageSize=20');
  console.log('status', r.status);
  console.log(r.body.substring(0, 2000));
})();
