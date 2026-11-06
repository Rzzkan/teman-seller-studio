import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const models = JSON.parse(readFileSync(new URL('./fixtures/models.json', import.meta.url), 'utf8'));
let mock, base, app, appBase, calls = [], failNext = false, failModels = new Set();

before(async () => {
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/models') return res.end(JSON.stringify(models));
      if (req.url === '/v1/account/balance') {
        const k = req.headers.authorization || '';
        if (k.endsWith('kn-ditolak0001')) { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'Invalid API key', code: 'invalid_api_key' } })); }
        if (k.endsWith('kn-terbatas001')) { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: 'restricted', code: 'restricted_key_not_allowed' } })); }
        return res.end(JSON.stringify({ object: 'account.balance', balance_micro_idr: 25000000000, reserved_micro_idr: 1500000, available_micro_idr: 24998500000, currency: 'IDR' }));
      }
      calls.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') });
      if (req.url.endsWith('/generations') && failModels.has(JSON.parse(Buffer.concat(chunks).toString()).model)) { res.statusCode = 503; return res.end(JSON.stringify({ error: { message: 'model sedang down', code: 'upstream_unavailable' } })); }
      if (failNext) { failNext = false; return res.end('   ' + JSON.stringify({ error: { message: 'provider gagal', code: 'upstream_error' } })); }
      let n = 1;
      if (req.url.endsWith('/generations')) n = JSON.parse(Buffer.concat(chunks).toString()).n || 1;
      res.end('  ' + JSON.stringify({ data: Array.from({ length: n }, () => ({ b64_json: PNG.toString('base64') })) }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${mock.address().port}/v1`;
  process.env.KENARI_BASE_URL = base;
  process.env.KENARI_API_KEY = 'kn-test';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tss-'));
  process.env.ACCESS_TOKEN = 'rahasia';
  process.env.MCP_PATH_SECRET = 'rahasia-konektor-0123456789abcdef';
  process.env.ADMIN_USER = 'bos';
  process.env.ADMIN_PASSWORD = 'sandi-panjang-123';
  process.env.PUBLIC_URL = 'https://studio.example.test';
  process.env.RETENTION_DAYS = '7';
  process.env.DAILY_BUDGET_IDR = '2000';
  process.env.APPROVAL_THRESHOLD_IDR = '1000';
  const { createApp } = await import('../src/server.js');
  const store = await import('../src/store.js');
  await store.init();
  app = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  appBase = `http://127.0.0.1:${app.address().port}`;
});
after(() => { mock.closeAllConnections(); mock.close(); app.closeAllConnections(); app.close(); });

const H = { Authorization: 'Bearer rahasia', 'Content-Type': 'application/json' };
const post = (p, b) => fetch(appBase + p, { method: 'POST', headers: H, body: JSON.stringify(b) });

test('API menolak tanpa token', async () => {
  assert.equal((await fetch(appBase + '/api/config')).status, 401);
  assert.equal((await fetch(appBase + '/mcp', { method: 'POST' })).status, 401);
});

test('daftar model dan harga dibaca dari kenari', async () => {
  const m = await (await fetch(appBase + '/api/models', { headers: H })).json();
  assert.equal(m.find((x) => x.id === 'gpt-image-2').pricePerImageIdr, 125);
  assert.equal(m.find((x) => x.id.endsWith(':free')).pricePerImageIdr, 0);
});

test('generate menyimpan file bernama sesuai aturan kantor dan mengirim bearer key', async () => {
  const r = await post('/api/generate', { prompt: 'kucing seller', n: 2, title: 'Kucing Seller', useStyle: false });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.images.length, 2);
  assert.match(body.images[0].file, /^\d{4}-\d{2}-\d{2}_Kenzo_Kucing-Seller_v1_01\.png$/);
  assert.equal(body.costIdr, 250);
  assert.equal(calls.at(-1).auth, 'Bearer kn-test');
  const again = await (await post('/api/generate', { prompt: 'x kucing', title: 'Kucing Seller', useStyle: false })).json();
  assert.match(again.images[0].file, /_v2_01\.png$/);
  const f = await fetch(`${appBase}/files/${body.images[0].file}?token=rahasia`);
  assert.equal(f.status, 200);
  assert.equal((await f.arrayBuffer()).byteLength, PNG.length);
});

test('biaya di atas ambang butuh approved=true', async () => {
  const r = await post('/api/generate', { prompt: 'mahal', model: 'grok-imagine-image-2-0', n: 1 });
  assert.equal(r.status, 200); // Rp900 <= ambang 1000
  const before = calls.length;
  const r2 = await post('/api/generate', { prompt: 'mahal', model: 'grok-imagine-image-2-0', n: 2 });
  assert.equal(r2.status, 402);
  assert.equal(calls.length, before, 'tidak boleh memanggil kenari tanpa persetujuan');
});

test('batas budget harian tidak bisa dilewati walau approved', async () => {
  const r = await post('/api/generate', { prompt: 'banyak', model: 'grok-imagine-image-2-0', n: 3, approved: true });
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /budget harian/i);
});

test('error status-200 dari kenari tidak dihitung biaya', async () => {
  const spent = async () => (await (await fetch(appBase + '/api/config', { headers: H })).json()).spentTodayIdr;
  const s0 = await spent();
  failNext = true;
  const r = await post('/api/generate', { prompt: 'gagal', n: 1 });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /provider gagal/);
  assert.equal(await spent(), s0);
});

test('edit mengirim multipart ke /images/edits', async () => {
  const r = await post('/api/edit', { prompt: 'ubah latar', imageBase64: PNG.toString('base64'), title: 'Edit Tes' });
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1).url, '/v1/images/edits');
  assert.match(calls.at(-1).body, /name="image"/);
});

test('MCP: tools terdaftar dan generate_image jalan', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['generate_image', 'edit_image', 'list_image_models', 'estimate_cost', 'list_gallery', 'get_image']) assert.ok(names.includes(n), n);
  const out = await client.callTool({ name: 'generate_image', arguments: { prompt: 'poster promo', title: 'Poster MCP', model: 'gpt-image-2' } });
  assert.ok(!out.isError, JSON.stringify(out));
  assert.equal(out.content.filter((c) => c.type === 'image').length, 1);
  const blocked = await client.callTool({ name: 'generate_image', arguments: { prompt: 'poster mahal', model: 'grok-imagine-image-2-0', n: 2 } });
  assert.equal(blocked.isError, true);
  await client.close();
});

test('path traversal pada /files ditolak', async () => {
  const r = await fetch(`${appBase}/files/..%2F..%2Fpackage.json?token=rahasia`);
  assert.equal(r.status, 404);
});

test('MCP: URL publik bertanda tangan bisa diambil, dirusak/kedaluwarsa ditolak', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  const gal = (await (await fetch(appBase + '/api/gallery', { headers: H })).json())[0];
  assert.ok(gal.expiresAt, 'entri punya expiresAt');
  const out = await client.callTool({ name: 'get_image_public_url', arguments: { id: gal.id, ttl_minutes: 5 } });
  assert.ok(!out.isError, JSON.stringify(out));
  const url = out.content[0].text.match(/source_url: (\S+)/)[1];
  assert.ok(url.startsWith('https://studio.example.test/p/'));
  const local = url.replace('https://studio.example.test', appBase);
  const ok = await fetch(local); // tanpa token: cukup tanda tangan
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /image\//);
  assert.equal((await fetch(local.replace(/sig=./, 'sig=0'))).status, 403);
  assert.equal((await fetch(local.replace(/exp=\d+/, 'exp=1'))).status, 403);
  await client.close();
});

test('retensi 7 hari: gambar kedaluwarsa disembunyikan lalu dihapus permanen oleh sweep', async () => {
  const store = await import('../src/store.js');
  const { config } = await import('../src/config.js');
  const idx = join(config.dataDir, 'index.json');
  const entries = JSON.parse(readFileSync(idx, 'utf8'));
  const victim = entries[0], survivor = entries.at(-1);
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  victim.createdAt = old; victim.expiresAt = new Date(Date.now() - 86400000).toISOString();
  writeFileSync(idx, JSON.stringify(entries));
  const listed = await (await fetch(appBase + '/api/gallery?limit=200', { headers: H })).json();
  assert.ok(!listed.some((e) => e.id === victim.id), 'kedaluwarsa tidak tampil walau belum di-sweep');
  assert.equal((await fetch(`${appBase}/files/${victim.file}?token=rahasia`)).status, 200, 'file masih di disk sebelum sweep');
  const r = await store.sweep();
  assert.ok(r.deleted >= 1);
  assert.ok(!existsSync(store.imagePath(victim.file)), 'file terhapus permanen');
  assert.ok(existsSync(store.imagePath(survivor.file)), 'gambar baru tetap ada');
  assert.ok(readFileSync(join(config.dataDir, 'deleted.log'), 'utf8').includes(victim.id));
  assert.ok(!JSON.parse(readFileSync(idx, 'utf8')).some((e) => e.id === victim.id));
});

const J = { 'Content-Type': 'application/json' };
const login = (body, ip = '10.0.0.1') => fetch(appBase + '/auth/login', { method: 'POST', headers: { ...J, 'X-Forwarded-For': ip }, body: JSON.stringify(body) });

test('login: halaman utama dialihkan ke /login, password salah ditolak, benar memberi cookie HttpOnly', async () => {
  const home = await fetch(appBase + '/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/login');
  assert.equal((await fetch(appBase + '/login')).status, 200);
  assert.equal((await login({ user: 'bos', password: 'salah' }, '10.0.0.2')).status, 401);
  assert.equal((await login({ user: 'lain', password: 'sandi-panjang-123' }, '10.0.0.2')).status, 401);
  const ok = await login({ user: 'bos', password: 'sandi-panjang-123' }, '10.0.0.3');
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const c = cookie.split(';')[0];
  assert.equal((await fetch(appBase + '/', { headers: { Cookie: c } })).status, 200);
  const cfgRes = await fetch(appBase + '/api/config', { headers: { Cookie: c } });
  assert.equal(cfgRes.status, 200);
  assert.equal((await cfgRes.json()).user, 'bos');
  const gal = await (await fetch(appBase + '/api/gallery', { headers: H })).json();
  assert.equal((await fetch(`${appBase}/files/${gal[0].file}`, { headers: { Cookie: c } })).status, 200, 'gambar bisa dibuka dengan sesi login');
  // CSRF: cookie + body non-JSON ditolak
  const bad = await fetch(appBase + '/api/styles', { method: 'POST', headers: { Cookie: c, 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(bad.status, 415);
  // cookie TIDAK dipakai untuk /mcp (hanya bearer)
  assert.equal((await fetch(appBase + '/mcp', { method: 'POST', headers: { ...J, Cookie: c }, body: '{}' })).status, 401);
  // cookie palsu / dirusak
  assert.equal((await fetch(appBase + '/api/config', { headers: { Cookie: c.slice(0, -3) + 'abc' } })).status, 401);
  // logout menghapus cookie
  const out = await fetch(appBase + '/auth/logout', { method: 'POST', headers: { ...J, Cookie: c }, body: '{}' });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('login: dikunci 15 menit setelah 5 kali gagal dari IP yang sama', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login({ user: 'bos', password: 'x' + i }, '10.9.9.9')).status, 401);
  const locked = await login({ user: 'bos', password: 'sandi-panjang-123' }, '10.9.9.9');
  assert.equal(locked.status, 429, 'bahkan password benar ditolak saat terkunci');
  assert.equal((await login({ user: 'bos', password: 'sandi-panjang-123' }, '10.8.8.8')).status, 200, 'IP lain tidak terpengaruh');
});

test('pengaturan biaya: validasi, batas harian/mingguan/bulanan benar-benar menahan generate', async () => {
  const put = (b) => fetch(appBase + '/api/settings', { method: 'PUT', headers: H, body: JSON.stringify(b) });
  assert.equal((await put({ dailyBudgetIdr: -5 })).status, 400);
  assert.equal((await put({ maxN: 11 })).status, 400);
  assert.equal((await put({ dailyBudgetIdr: 1.5 })).status, 400);
  const gen = () => post('/api/generate', { prompt: 'uji batas', model: 'gpt-image-2', useStyle: false });
  const before = calls.length;

  assert.equal((await put({ dailyBudgetIdr: 100, weeklyBudgetIdr: 0, monthlyBudgetIdr: 0 })).status, 200);
  let r = await gen();
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /harian/i);

  const cfg0 = await (await fetch(appBase + '/api/config', { headers: H })).json();
  assert.equal(cfg0.dailyBudgetIdr, 100);
  await put({ dailyBudgetIdr: 0, weeklyBudgetIdr: cfg0.spentWeekIdr + 100 });
  r = await gen();
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /mingguan/i);

  await put({ weeklyBudgetIdr: 0, monthlyBudgetIdr: cfg0.spentMonthIdr + 100 });
  r = await gen();
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /bulanan/i);
  assert.equal(calls.length, before, 'kenari tidak dipanggil saat batas terlewati');

  await put({ monthlyBudgetIdr: 0, maxN: 2 }); // tanpa batas: generate lolos, n dipotong ke maxN
  r = await post('/api/generate', { prompt: 'uji maxn', model: 'gpt-image-2', n: 5, useStyle: false });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).images.length, 2);
  await put({ dailyBudgetIdr: 2000, maxN: 5 }); // pulihkan
});

test('ledger: total biaya tidak hilang saat gambar dihapus oleh retensi', async () => {
  const store = await import('../src/store.js');
  const before = await store.usage();
  assert.ok(before.today > 0);
  const { config } = await import('../src/config.js');
  const idx = join(config.dataDir, 'index.json');
  const entries = JSON.parse(readFileSync(idx, 'utf8'));
  for (const e of entries) e.expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(idx, JSON.stringify(entries));
  const r = await store.sweep();
  assert.ok(r.deleted > 0);
  assert.deepEqual(await store.usage(), before, 'pemakaian tetap sama setelah semua gambar dihapus');
});

test('share dari web: butuh gambar ada; PUBLIC_URL https dipakai', async () => {
  const g = await (await post('/api/generate', { prompt: 'untuk share', model: 'gpt-image-2', useStyle: false })).json();
  const r = await post('/api/share', { id: g.images[0].id, ttlMinutes: 10 });
  assert.equal(r.status, 200);
  assert.match((await r.json()).url, /^https:\/\/studio\.example\.test\/p\//);
  assert.equal((await post('/api/share', { id: 'tidakada' })).status, 404);
});

test('weekStartOf: pekan dimulai Senin', async () => {
  const { weekStartOf } = await import('../src/store.js');
  assert.equal(weekStartOf('2026-11-05'), '2026-11-02'); // Kamis -> Senin
  assert.equal(weekStartOf('2026-11-02'), '2026-11-02');
  assert.equal(weekStartOf('2026-11-08'), '2026-11-02'); // Minggu masih pekan yang sama
});

test('URL konektor /mcp/<rahasia>: tools terbuka tanpa header, rahasia salah ditolak, tidak membuka API', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp/rahasia-konektor-0123456789abcdef')));
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('generate_image') && names.includes('get_image_public_url'));
  await client.close();
  assert.equal((await fetch(appBase + '/mcp/salah-salah-salah-salah-salah', { method: 'POST', headers: J, body: '{}' })).status, 404);
  assert.equal((await fetch(appBase + '/mcp/pendek', { method: 'POST', headers: J, body: '{}' })).status, 404);
  assert.equal((await fetch(appBase + '/api/config?x=/mcp/rahasia-konektor-0123456789abcdef')).status, 401, 'rahasia tidak membuka API');
});

test('rahasia konektor hanya ditampilkan ke admin yang login, tidak ke bearer token', async () => {
  const viaToken = await (await fetch(appBase + '/api/config', { headers: H })).json();
  assert.equal(viaToken.mcpPathSecret, null);
  const ok = await login({ user: 'bos', password: 'sandi-panjang-123' }, '10.7.7.7');
  const c = ok.headers.get('set-cookie').split(';')[0];
  const viaSession = await (await fetch(appBase + '/api/config', { headers: { Cookie: c } })).json();
  assert.equal(viaSession.mcpPathSecret, 'rahasia-konektor-0123456789abcdef');
});

test('konfigurasi API key: hanya admin web, dicek ke kenari, tersamarkan, langsung dipakai, bisa dihapus', async () => {
  const { statSync } = await import('node:fs');
  const key = (b, headers) => fetch(appBase + '/api/kenari/key', { method: 'PUT', headers, body: JSON.stringify(b) });
  // token mesin (Claude) tidak boleh mengubah key
  assert.equal((await key({ apiKey: 'kn-baru-abcdef123456' }, H)).status, 403);
  assert.equal((await fetch(appBase + '/api/kenari/key', { method: 'DELETE', headers: H })).status, 403);
  assert.equal((await fetch(appBase + '/api/kenari/test', { method: 'POST', headers: H, body: '{}' })).status, 403);

  const c = (await login({ user: 'bos', password: 'sandi-panjang-123' }, '10.6.6.6')).headers.get('set-cookie').split(';')[0];
  const S = { Cookie: c, 'Content-Type': 'application/json' };
  assert.equal((await key({ apiKey: 'bukan-key' }, S)).status, 400, 'format salah');
  const rej = await key({ apiKey: 'kn-ditolak0001' }, S);
  assert.equal(rej.status, 400, 'ditolak kenari -> tidak disimpan');
  assert.equal((await (await fetch(appBase + '/api/config', { headers: S })).json()).apiKeySource, 'env');

  const t = await (await fetch(appBase + '/api/kenari/test', { method: 'POST', headers: S, body: '{}' })).json();
  assert.equal(t.state, 'valid');
  assert.equal(t.balanceIdr, 25000);
  assert.equal(t.availableIdr, 24998.5);

  const restricted = await key({ apiKey: 'kn-terbatas001' }, S);
  assert.equal(restricted.status, 200);
  assert.equal((await restricted.json()).check.state, 'restricted');

  const full = 'kn-baru-abcdef123456';
  const okRes = await key({ apiKey: full }, S);
  assert.equal(okRes.status, 200);
  const okBody = await okRes.text();
  assert.ok(!okBody.includes(full), 'key penuh tidak boleh dikirim balik');
  const cfg = await (await fetch(appBase + '/api/config', { headers: S })).json();
  assert.equal(cfg.apiKeySource, 'dashboard');
  assert.equal(cfg.apiKeyMasked, 'kn-••••3456');
  assert.ok(!JSON.stringify(cfg).includes(full));
  assert.equal(statSync(join(process.env.DATA_DIR, 'secrets.json')).mode & 0o077, 0, 'berkas rahasia hanya bisa dibaca pemilik');

  const free = models.data.find((m) => m.id.endsWith(':free') && m.endpoints.includes('images')).id; // gratis: tidak tersangkut batas harian
  const r = await post('/api/generate', { prompt: 'pakai key baru', useStyle: false, model: free });
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1).auth, `Bearer ${full}`, 'key dashboard langsung dipakai tanpa restart');

  const del = await fetch(appBase + '/api/kenari/key', { method: 'DELETE', headers: S });
  assert.equal((await del.json()).source, 'env');
  await post('/api/generate', { prompt: 'kembali ke env', useStyle: false, model: free });
  assert.equal(calls.at(-1).auth, 'Bearer kn-test');
});

test('model default dari dashboard: divalidasi dan dipakai generate tanpa parameter model', async () => {
  const put = (b) => fetch(appBase + '/api/settings', { method: 'PUT', headers: H, body: JSON.stringify(b) });
  assert.equal((await put({ defaultModel: 'model-ngawur' })).status, 400);
  assert.equal((await put({ defaultModel: 'a b;c' })).status, 400);
  const free = models.data.find((m) => m.id.endsWith(':free') && m.endpoints.includes('images')).id;
  assert.equal((await put({ defaultModel: free })).status, 200);
  const cfg = await (await fetch(appBase + '/api/config', { headers: H })).json();
  assert.equal(cfg.defaultModel, free);
  const r = await post('/api/generate', { prompt: 'tanpa model', useStyle: false });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).estimate.model, free);
  assert.match(calls.at(-1).body, new RegExp(free.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await put({ defaultModel: 'gpt-image-2' }); // pulihkan
});

test('model cadangan: model utama gagal -> pindah ke cadangan, tercatat di log, biaya mengikuti model yang dipakai', async () => {
  const put = (b) => fetch(appBase + '/api/settings', { method: 'PUT', headers: H, body: JSON.stringify(b) });
  const free = models.data.filter((m) => m.id.endsWith(':free') && m.endpoints.includes('images')).map((m) => m.id);
  assert.equal((await put({ fallbackModels: ['model-ngawur'] })).status, 400, 'harus ada di daftar kenari');
  assert.equal((await put({ fallbackModels: ['a', 'b', 'c', 'd', 'e', 'f'] })).status, 400, 'maksimal 5');
  assert.equal((await put({ defaultModel: free[0], fallbackModels: [free[0], free[1], 'gpt-image-2'], dailyBudgetIdr: 100000 })).status, 200);

  failModels = new Set([free[0]]);
  let r = await post('/api/generate', { prompt: 'uji cadangan', useStyle: false });
  assert.equal(r.status, 200);
  let b = await r.json();
  assert.equal(b.modelUsed, free[1]);
  assert.equal(b.fallbackFrom, free[0]);
  assert.equal(b.costIdr, 0);
  assert.equal(b.images[0].model, free[1]);

  // semua gratis gagal -> cadangan berbayar (Rp125 <= ambang) dipakai dan dihitung biayanya
  failModels = new Set([free[0], free[1]]);
  r = await post('/api/generate', { prompt: 'uji cadangan 2', useStyle: false });
  b = await r.json();
  assert.equal(b.modelUsed, 'gpt-image-2');
  assert.equal(b.costIdr, 125);

  // semua gagal -> galat gabungan, tidak ada biaya
  failModels = new Set([free[0], free[1], 'gpt-image-2']);
  r = await post('/api/generate', { prompt: 'uji cadangan 3', useStyle: false });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /Semua model gagal/);

  // cadangan yang lebih mahal dari yang disetujui dilewati (butuh persetujuan baru)
  await put({ fallbackModels: ['grok-imagine-image-2-0'], approvalThresholdIdr: 100 });
  failModels = new Set([free[0]]);
  r = await post('/api/generate', { prompt: 'uji cadangan 4', useStyle: false, approved: true });
  assert.equal(r.status, 502, 'cadangan dilewati -> tidak ada model yang bisa dipakai');
  const logs = await (await fetch(appBase + '/api/logs?limit=50', { headers: H })).json();
  assert.ok(logs.some((l) => l.status === 'skipped' && l.model === 'grok-imagine-image-2-0'), 'cadangan mahal dicatat dilewati');
  assert.ok(logs.some((l) => l.status === 'error' && l.model === free[0] && l.httpStatus === 503));
  assert.ok(logs.some((l) => l.status === 'ok' && l.fallbackFrom === free[0]));
  assert.ok(!JSON.stringify(logs).includes('uji cadangan'), 'log tidak memuat prompt');
  assert.equal((await (await fetch(appBase + '/api/logs?issues=1', { headers: H })).json()).every((l) => l.status !== 'ok' || l.fallbackFrom), true);

  failModels = new Set();
  await put({ defaultModel: 'gpt-image-2', fallbackModels: [], approvalThresholdIdr: 1000, dailyBudgetIdr: 2000 }); // pulihkan
});

test('Style Guide jamak: dasar + per pilar, tambah/ubah/hapus, dipakai di prompt, MCP bisa memilih', async () => {
  const free = models.data.find((m) => m.id.endsWith(':free') && m.endpoints.includes('images')).id;
  const api = (m, p, b) => fetch(appBase + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  assert.equal((await api('POST', '/api/styles', { name: '  ' })).status, 400);
  const base = await (await api('POST', '/api/styles', { name: 'Gaya dasar', text: 'TEKS-DASAR', base: true })).json();
  const ngopi = await (await api('POST', '/api/styles', { name: 'Ngopi Dulu', pillar: 'Ngopi Dulu', text: 'TEKS-NGOPI' })).json();
  assert.equal((await api('POST', '/api/styles', { name: 'ngopi dulu' })).status, 400, 'nama kembar (tak peka huruf besar)');
  assert.equal(base.base, true);

  const gen = (b) => post('/api/generate', { prompt: 'uji style', model: free, ...b });
  let r = await gen({ style: 'Ngopi Dulu' });
  assert.equal(r.status, 200);
  assert.match(calls.at(-1).body, /TEKS-DASAR/);
  assert.match(calls.at(-1).body, /TEKS-NGOPI/);
  assert.equal((await r.json()).images[0].style, 'Gaya dasar + Ngopi Dulu');
  await gen({});
  assert.match(calls.at(-1).body, /TEKS-DASAR/);
  assert.doesNotMatch(calls.at(-1).body, /TEKS-NGOPI/, 'tanpa pilihan: hanya gaya dasar');
  await gen({ useStyle: false, style: 'Ngopi Dulu' });
  assert.doesNotMatch(calls.at(-1).body, /TEKS-/, 'useStyle=false mematikan semuanya');
  const before = calls.length;
  r = await gen({ style: 'tidak-ada' });
  assert.equal(r.status, 400);
  assert.equal(calls.length, before, 'style tak dikenal tidak memanggil kenari');

  // hanya satu gaya dasar
  await api('PUT', `/api/styles/${ngopi.id}`, { base: true });
  const all = (await (await api('GET', '/api/styles')).json()).styles;
  assert.deepEqual(all.filter((x) => x.base).map((x) => x.name), ['Ngopi Dulu']);
  await api('PUT', `/api/styles/${base.id}`, { base: true });

  // seed 7 pilar (tidak menimpa yang ada)
  const seed = await (await api('POST', '/api/styles/seed-pillars')).json();
  assert.equal(seed.added.length, 6, 'Ngopi Dulu sudah ada');
  assert.equal((await (await api('POST', '/api/styles/seed-pillars')).json()).added.length, 0);
  assert.equal((await (await api('GET', '/api/styles')).json()).styles.find((x) => x.name === 'Ngopi Dulu').text, 'TEKS-NGOPI');

  // MCP: list / set (upsert) / pilih style
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  const list = await client.callTool({ name: 'list_style_guides', arguments: {} });
  assert.match(list.content[0].text, /\[DASAR\] Gaya dasar/);
  assert.match(list.content[0].text, /Satu Langkah Kecil/);
  await client.callTool({ name: 'set_style_guide', arguments: { name: 'Pilar Uji', text: 'TEKS-UJI', pillar: 'Uji' } });
  const got = await client.callTool({ name: 'get_style_guide', arguments: { name: 'pilar uji' } });
  assert.match(got.content[0].text, /TEKS-UJI/);
  const out = await client.callTool({ name: 'generate_image', arguments: { prompt: 'via mcp', model: free, style: 'Pilar Uji' } });
  assert.ok(!out.isError, JSON.stringify(out));
  assert.match(calls.at(-1).body, /TEKS-UJI/);
  const bad = await client.callTool({ name: 'generate_image', arguments: { prompt: 'via mcp', model: free, style: 'ngawur' } });
  assert.equal(bad.isError, true);
  await client.close();

  // hapus
  const del = await api('DELETE', `/api/styles/${ngopi.id}`);
  assert.equal(del.status, 200);
  assert.equal((await api('DELETE', `/api/styles/${ngopi.id}`)).status, 404);
});

test('Style Guide di database SQLite: Claude kelola lewat MCP, hapus butuh approved, bisa dipulihkan, riwayat tercatat', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { err: r.isError, text: r.content[0].text }; };
  assert.ok(existsSync(join(process.env.DATA_DIR, 'studio.db')), 'database dibuat');

  const made = await call('set_style_guide', { name: 'Promo Gajian', pillar: 'Kabar Pasar', text: 'VERSI-1 tanggal gajian, warna merah-krem' });
  assert.ok(!made.err, made.text);
  await call('set_style_guide', { name: 'Promo Gajian', text: 'VERSI-2 lebih kalem' });
  assert.match((await call('get_style_guide', { name: 'Promo Gajian' })).text, /VERSI-2/);
  assert.match((await call('list_style_guides', {})).text, /Promo Gajian .*oleh claude \(MCP\)|Promo Gajian \| pilar: Kabar Pasar \| diubah .* oleh claude \(MCP\)/);

  // riwayat + kembalikan ke revisi lama
  const hist = (await call('style_guide_history', { name: 'Promo Gajian' })).text;
  assert.match(hist, /create oleh claude \(MCP\)/);
  const v1 = hist.split('\n').find((l) => l.includes('VERSI-1')).match(/^rev (\d+)/)[1];
  assert.ok(!(await call('restore_style_guide', { revision_id: Number(v1) })).err);
  assert.match((await call('get_style_guide', { name: 'Promo Gajian' })).text, /VERSI-1/);

  // menghapus: butuh persetujuan Owner; hapus lunak; bisa dipulihkan
  const noAppr = await call('delete_style_guide', { name: 'Promo Gajian' });
  assert.equal(noAppr.err, true);
  assert.match(noAppr.text, /persetujuan Owner/);
  assert.match((await call('get_style_guide', { name: 'Promo Gajian' })).text, /VERSI-1/, 'belum terhapus');
  assert.ok(!(await call('delete_style_guide', { name: 'Promo Gajian', approved: true })).err);
  assert.match((await call('get_style_guide', { name: 'Promo Gajian' })).text, /tidak ditemukan/);
  assert.match((await call('list_style_guides', {})).text, /Dihapus .*Promo Gajian/);
  const gen = await client.callTool({ name: 'generate_image', arguments: { prompt: 'x style hilang', style: 'Promo Gajian', model: models.data.find((m) => m.id.endsWith(':free')).id } });
  assert.equal(gen.isError, true, 'style terhapus tidak bisa dipakai');
  assert.ok(!(await call('restore_style_guide', { name: 'Promo Gajian' })).err);
  assert.match((await call('get_style_guide', { name: 'Promo Gajian' })).text, /VERSI-1/);

  // Claude menjadikan style sebagai gaya dasar -> tetap hanya satu dasar
  await call('set_style_guide', { name: 'Promo Gajian', text: 'VERSI-1 tanggal gajian, warna merah-krem', base: true });
  const web = (await (await fetch(appBase + '/api/styles', { headers: H })).json()).styles;
  assert.deepEqual(web.filter((x) => x.base).map((x) => x.name), ['Promo Gajian']);
  assert.equal(web.find((x) => x.name === 'Promo Gajian').updatedBy, 'claude (MCP)');
  await client.close();
});

test('Style Guide: data lama (styles.json dan style.txt) dimigrasi ke database sekali jalan', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const run = (dir) => spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `const s = await import(${JSON.stringify(new URL('../src/styles.js', import.meta.url).href)}); console.log(JSON.stringify(s.list().map(x => [x.name, x.text, x.base])));`],
  { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  const d1 = mkdtempSync(join(tmpdir(), 'mig1-'));
  writeFileSync(join(d1, 'style.txt'), 'gaya lama satu');
  assert.deepEqual(JSON.parse(run(d1).stdout), [['Gaya dasar', 'gaya lama satu', true]]);
  assert.deepEqual(JSON.parse(run(d1).stdout), [['Gaya dasar', 'gaya lama satu', true]], 'jalan kedua tidak menggandakan');
  const d2 = mkdtempSync(join(tmpdir(), 'mig2-'));
  mkdirSync(d2, { recursive: true });
  writeFileSync(join(d2, 'styles.json'), JSON.stringify({ styles: [{ id: 'a1', name: 'Ngopi Dulu', pillar: 'Ngopi Dulu', text: 'T1', base: false }, { id: 'a2', name: 'Dasar', text: 'T2', base: true }] }));
  const out = JSON.parse(run(d2).stdout);
  assert.deepEqual(out, [['Dasar', 'T2', true], ['Ngopi Dulu', 'T1', false]]);
  assert.ok(existsSync(join(d2, 'styles.json.migrated')));
});

// ---- Layanan klien: Style Guide, galeri, biaya, dan retensi per klien ----
const mcpClient = async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  return async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { err: r.isError, text: r.content[0].text }; };
};
const freeModel = () => models.data.find((m) => m.id.endsWith(':free') && m.endpoints.includes('images')).id;

test('klien: Style Guide terpisah, gaya Teman Seller tidak bocor ke gambar klien', async () => {
  const call = await mcpClient();
  await call('set_style_guide', { text: 'GAYA-INTERNAL-TS', base: true });                       // dasar Teman Seller
  assert.ok(!(await call('set_style_guide', { client: 'Toko Ayu', text: 'MERAH-AYU', base: true })).err);
  assert.ok(!(await call('set_style_guide', { client: 'Toko Budi', text: 'BIRU-BUDI', base: true })).err);
  assert.ok(!(await call('set_style_guide', { client: 'Toko Ayu', name: 'Promo Ayu', pillar: 'Promo', text: 'DISKON-AYU' })).err);
  // nama sama boleh dipakai klien berbeda; dasar tetap satu per klien
  assert.ok(!(await call('set_style_guide', { client: 'Toko Budi', name: 'Promo Ayu', text: 'PROMO-BUDI' })).err);
  const all = (await (await fetch(appBase + '/api/styles', { headers: H })).json());
  assert.deepEqual(all.clients, ['Toko Ayu', 'Toko Budi']);
  assert.equal(all.styles.filter((x) => x.base && x.client === 'Toko Ayu').length, 1);
  assert.equal(all.styles.filter((x) => x.base && x.client === '').length, 1, 'dasar Teman Seller tidak terganggu');
  assert.match((await call('list_style_guides', { client: 'Toko Ayu' })).text, /MERAH-AYU/);
  assert.doesNotMatch((await call('list_style_guides', { client: 'Toko Ayu' })).text, /BIRU-BUDI|GAYA-INTERNAL-TS/);
  assert.doesNotMatch((await call('list_style_guides', {})).text, /MERAH-AYU|BIRU-BUDI/, 'daftar internal tidak menampilkan klien');

  const sent = () => decodeURIComponent(calls.at(-1).body);
  const ok = await call('generate_image', { prompt: 'poster promo', client: 'Toko Ayu', style: 'Promo Ayu', model: freeModel(), return_images: false });
  assert.ok(!ok.err, ok.text);
  assert.match(sent(), /MERAH-AYU/); assert.match(sent(), /DISKON-AYU/);
  assert.doesNotMatch(sent(), /BIRU-BUDI|PROMO-BUDI|GAYA-INTERNAL-TS/);
  // gaya milik klien lain tidak bisa dipakai lewat nama
  const cross = await call('generate_image', { prompt: 'x', client: 'Toko Ayu', style: 'Promo Budi', model: freeModel() });
  assert.equal(cross.err, true);
  // tanpa klien tetap gaya Teman Seller saja
  await call('generate_image', { prompt: 'internal', model: freeModel(), return_images: false });
  assert.match(sent(), /GAYA-INTERNAL-TS/); assert.doesNotMatch(sent(), /MERAH-AYU/);
  // hapus + pulihkan dalam lingkup klien
  assert.ok((await call('delete_style_guide', { client: 'Toko Ayu', name: 'Promo Ayu' })).err, 'butuh approved');
  assert.ok(!(await call('delete_style_guide', { client: 'Toko Ayu', name: 'Promo Ayu', approved: true })).err);
  assert.match((await call('get_style_guide', { client: 'Toko Budi', name: 'Promo Ayu' })).text, /PROMO-BUDI/, 'milik klien lain utuh');
  assert.ok(!(await call('restore_style_guide', { client: 'Toko Ayu', name: 'Promo Ayu' })).err);
  assert.match((await call('get_style_guide', { client: 'Toko Ayu', name: 'Promo Ayu' })).text, /DISKON-AYU/);
});

test('klien: galeri dilabeli dan bisa difilter, list_clients merekap gambar', async () => {
  const call = await mcpClient();
  const g = await (await post('/api/generate', { prompt: 'label klien', client: 'Toko Budi', useStyle: false, model: freeModel() })).json();
  assert.equal(g.images[0].client, 'Toko Budi');
  const only = await (await fetch(appBase + '/api/gallery?client=' + encodeURIComponent('toko budi'), { headers: H })).json();
  assert.ok(only.length >= 1 && only.every((e) => e.client === 'Toko Budi'), 'filter tidak peduli huruf besar-kecil');
  const internal = await (await fetch(appBase + '/api/gallery?client=-', { headers: H })).json();
  assert.ok(internal.length >= 1 && internal.every((e) => e.client === ''));
  const all = await (await fetch(appBase + '/api/gallery?limit=500', { headers: H })).json();
  assert.ok(all.length > only.length + internal.length - 1);
  const lc = await call('list_clients', {});
  assert.match(lc.text, /Toko Budi \| \d+ style \| \d+ gambar/);
  assert.match(lc.text, /Toko Ayu/);
});

test('klien: batas biaya per klien terpisah dari batas global, biaya tercatat per klien', async () => {
  const before = (await (await fetch(appBase + '/api/settings', { headers: H })).json()).settings;
  const put = (b) => fetch(appBase + '/api/settings', { method: 'PUT', headers: H, body: JSON.stringify(b) });
  try {
    assert.equal((await put({ dailyBudgetIdr: 0, weeklyBudgetIdr: 0, monthlyBudgetIdr: 0, approvalThresholdIdr: 100000, clientDailyBudgetIdr: 200 })).status, 200);
    const paid = 'gpt-image-2'; // Rp125 per gambar
    const one = await post('/api/generate', { prompt: 'klien berbayar', client: 'Toko Cici', useStyle: false, model: paid, n: 1 });
    assert.equal(one.status, 200, await one.clone().text());
    const two = await post('/api/generate', { prompt: 'klien berbayar lagi', client: 'Toko Cici', useStyle: false, model: paid, n: 1 });
    assert.equal(two.status, 402, 'Rp125 + Rp125 melewati batas harian klien Rp200');
    assert.match((await two.json()).error, /harian klien Toko Cici/);
    // klien lain dan pekerjaan internal tidak terblokir
    assert.equal((await post('/api/generate', { prompt: 'klien lain', client: 'Toko Dedi', useStyle: false, model: paid, n: 1 })).status, 200);
    assert.equal((await post('/api/generate', { prompt: 'internal bayar', useStyle: false, model: paid, n: 1 })).status, 200);
    const cfg = await (await fetch(appBase + '/api/config', { headers: H })).json();
    assert.equal(cfg.byClient.find((x) => x.client === 'Toko Cici').today, 125);
    assert.equal(cfg.byClient.find((x) => x.client === 'Toko Dedi').today, 125);
    assert.ok(!cfg.byClient.some((x) => x.client === ''), 'Teman Seller tidak masuk rekap klien');
    const est = await (await fetch(appBase + '/api/estimate?model=gpt-image-2&n=1&client=Toko%20Cici', { headers: H })).json();
    assert.equal(est.spentClientTodayIdr, 125);
    assert.match((await (await mcpClient())('list_clients', {})).text, /Toko Cici .*biaya hari ini Rp125/);
  } finally {
    await put({ dailyBudgetIdr: before.dailyBudgetIdr, weeklyBudgetIdr: before.weeklyBudgetIdr, monthlyBudgetIdr: before.monthlyBudgetIdr, approvalThresholdIdr: before.approvalThresholdIdr, clientDailyBudgetIdr: 0 });
  }
});

test('retensi: gambar bertanda simpan tidak disapu; lepas tanda memulai hitung mundur', async () => {
  const store = await import('../src/store.js');
  const call = await mcpClient();
  const g = await (await post('/api/generate', { prompt: 'final klien', client: 'Toko Ayu', useStyle: false, model: freeModel() })).json();
  const id = g.images[0].id, file = g.images[0].file;
  const k = await (await fetch(`${appBase}/api/gallery/${id}/keep`, { method: 'PUT', headers: H, body: JSON.stringify({ keep: true }) })).json();
  assert.equal(k.keep, true); assert.equal(k.expiresAt, null);
  const future = Date.now() + 30 * 86400000;                       // 30 hari lagi: yang tidak disimpan sudah kedaluwarsa
  await store.sweep({ now: future });
  assert.ok(await store.getImage(id), 'bertanda simpan: masih ada');
  assert.ok(existsSync(store.imagePath(file)));
  assert.match((await call('list_gallery', { client: 'Toko Ayu', limit: 5 })).text, /DISIMPAN/);
  assert.match((await call('get_image_public_url', { id })).text, /source_url: https:\/\/studio\.example\.test\/p\//, 'tautan publik tetap dibuat tanpa tanggal kedaluwarsa gambar');
  const un = await (await fetch(`${appBase}/api/gallery/${id}/keep`, { method: 'PUT', headers: H, body: JSON.stringify({ keep: false }) })).json();
  assert.equal(un.keep, false); assert.ok(new Date(un.expiresAt) > new Date(), 'hitung mundur baru');
  assert.equal((await fetch(`${appBase}/api/gallery/tidakada/keep`, { method: 'PUT', headers: H, body: '{}' })).status, 404);
  assert.ok(!(await call('keep_image', { id })).err);
  await store.sweep({ now: future });
  assert.ok(await store.getImage(id), 'ditandai lagi lewat MCP');
});

test('migrasi: database Style Guide lama (tanpa kolom client) ditingkatkan tanpa kehilangan data', async () => {
  const { spawnSync } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'mig3-'));
  const d = new DatabaseSync(join(dir, 'studio.db'));
  d.exec(`
    CREATE TABLE styles (id TEXT PRIMARY KEY, name TEXT NOT NULL, pillar TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', base INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT 'web', deleted_at TEXT);
    CREATE UNIQUE INDEX styles_name_live ON styles (lower(name)) WHERE deleted_at IS NULL;
    CREATE TABLE style_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, style_id TEXT NOT NULL, name TEXT NOT NULL, pillar TEXT NOT NULL, text TEXT NOT NULL, base INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL);
    INSERT INTO styles (id, name, pillar, text, base, updated_at) VALUES ('s1', 'Dasar Lama', '', 'TEKS-LAMA', 1, '2026-11-01T00:00:00Z');
  `);
  d.close();
  const script = `const s = await import(${JSON.stringify(new URL('../src/styles.js', import.meta.url).href)});
    s.create({ client: 'Klien Baru', name: 'Dasar Lama', text: 'BEDA', base: true });
    console.log(JSON.stringify(s.list().map(x => [x.name, x.client, x.text, x.base])));
    console.log(JSON.stringify(s.history('Dasar Lama', 5).map(r => r.client)));`;
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [rows, hist] = r.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(rows), [['Dasar Lama', '', 'TEKS-LAMA', true], ['Dasar Lama', 'Klien Baru', 'BEDA', true]]);
  assert.ok(JSON.parse(hist));
});
