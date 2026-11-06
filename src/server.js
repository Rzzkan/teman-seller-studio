import express from 'express';
import { resolve } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import * as store from './store.js';
import * as service from './service.js';
import * as kenari from './kenari.js';
import { buildMcpServer } from './mcp.js';
import { ApprovalRequired } from './service.js';
import { detectMime } from './kenari.js';
import { verify, signedUrl } from './share.js';
import * as settings from './settings.js';
import * as secrets from './secrets.js';
import * as log from './log.js';
import * as styles from './styles.js';
import { COOKIE, loginEnabled, safeEqual, checkCredentials, makeToken, readToken, parseCookies, setCookie, clearCookie } from './auth.js';

const fails = new Map(); // ip -> { n, until } : pembatas percobaan login
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // di belakang Caddy/Nginx: baca IP asli dan https dari X-Forwarded-*
  app.use(express.json({ limit: '40mb' }));

  const open = () => !config.accessToken && !loginEnabled();
  // 'token' = bearer ACCESS_TOKEN (mesin/Claude), 'session' = login web, null = belum terautentikasi
  async function who(req) {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (config.accessToken && bearer && safeEqual(bearer, config.accessToken)) return 'token';
    if (loginEnabled() && (await readToken(parseCookies(req.headers.cookie)[COOKIE]))) return 'session';
    return null;
  }
  const auth = async (req, res, next) => {
    if (open()) return next();
    const w = await who(req);
    if (!w) return res.status(401).json({ error: 'Belum login atau token salah', loginRequired: loginEnabled() });
    // Sesi berbasis cookie: tolak POST/PUT non-JSON (perlindungan CSRF tambahan di atas SameSite=Lax)
    if (w === 'session' && !['GET', 'HEAD'].includes(req.method) && !(req.headers['content-type'] || '').includes('application/json')) return res.status(415).json({ error: 'Content-Type harus application/json' });
    next();
  };
  // Pengaturan sensitif (API key): hanya admin yang login di web (atau server tanpa autentikasi, mode lokal).
  const adminOnly = async (req, res, next) => {
    if (open() || (await who(req)) === 'session') return next();
    return res.status(403).json({ error: 'Hanya admin yang login di dashboard yang boleh mengubah ini' });
  };
  const bearerOnly = async (req, res, next) => {
    if (!config.accessToken) return open() ? next() : res.status(401).json({ error: 'ACCESS_TOKEN belum diatur di server' });
    return (await who(req)) === 'token' ? next() : res.status(401).json({ error: 'Token salah atau belum diisi' });
  };

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // ---- Halaman + login ----
  const pub = (name) => resolve(config.root, 'public', name);
  app.get(['/', '/index.html'], async (req, res) => {
    if (loginEnabled() && !(await who(req))) return res.redirect('/login');
    res.sendFile(pub('index.html'));
  });
  app.get('/login', async (req, res) => {
    if (loginEnabled() && (await who(req))) return res.redirect('/');
    res.sendFile(pub('login.html'));
  });
  app.get('/auth/me', async (req, res) => {
    const w = await who(req);
    res.json({ loginRequired: loginEnabled(), loggedIn: open() || Boolean(w), user: w === 'session' ? config.adminUser : null });
  });
  app.post('/auth/login', async (req, res) => {
    if (!loginEnabled()) return res.status(404).json({ error: 'Login web tidak diaktifkan (ADMIN_PASSWORD kosong)' });
    const rec = fails.get(req.ip) || { n: 0, until: 0 };
    if (rec.until > Date.now()) return res.status(429).json({ error: `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil((rec.until - Date.now()) / 60000)} menit.` });
    if (!checkCredentials(req.body?.user, req.body?.password)) {
      rec.n += 1;
      if (rec.n >= MAX_FAILS) { rec.until = Date.now() + LOCK_MS; rec.n = 0; }
      fails.set(req.ip, rec);
      return res.status(401).json({ error: 'User atau password salah' });
    }
    fails.delete(req.ip);
    res.set('Set-Cookie', setCookie(await makeToken(config.adminUser), { secure: req.secure })).json({ ok: true });
  });
  app.post('/auth/logout', (req, res) => {
    res.set('Set-Cookie', clearCookie({ secure: req.secure })).json({ ok: true });
  });

  app.use(express.static(resolve(config.root, 'public'), { index: false }));

  const api = express.Router();
  api.use(auth);

  api.get('/config', async (req, res) => {
    const [st, u, w, byClient] = await Promise.all([settings.get(), store.usage(), who(req), store.usageByClient()]);
    res.json({
      ...st,
      spentTodayIdr: u.today,
      spentWeekIdr: u.week,
      spentMonthIdr: u.month,
      byClient,
      clients: styles.clients(),
      weekStart: u.weekStart,
      monthStart: u.monthStart,
      hasApiKey: secrets.keyInfo().hasKey,
      apiKeyMasked: secrets.keyInfo().masked,
      apiKeySource: secrets.keyInfo().source,
      retentionDays: config.retentionDays,
      user: w === 'session' ? config.adminUser : null,
      publicUrlSet: config.publicUrl.startsWith('https://'),
      // rahasia konektor hanya ditunjukkan ke admin yang login (bukan ke pemegang token mesin)
      mcpPathSecret: w === 'session' && config.mcpPathSecret.length >= 24 ? config.mcpPathSecret : null,
    });
  });
  api.get('/settings', async (_req, res, next) => {
    try { res.json({ settings: await settings.get(), defaults: settings.defaults() }); } catch (e) { next(e); }
  });
  api.put('/settings', async (req, res, next) => {
    try {
      const ids = [req.body?.defaultModel, ...(Array.isArray(req.body?.fallbackModels) ? req.body.fallbackModels : [])].filter((x) => x !== undefined);
      if (ids.length) {
        // Pastikan model ada di daftar kenari. Jika daftar tidak bisa diambil, terima apa adanya.
        const list = await kenari.listImageModels({ force: true }).catch(() => null);
        const bad = list && ids.find((x) => !list.some((m) => m.id === x));
        if (bad) return res.status(400).json({ error: `Model "${bad}" tidak ada di daftar model gambar kenari` });
      }
      res.json({ settings: await settings.set(req.body || {}) });
    } catch (e) { next(e); }
  });

  // ---- API key kenari (hanya admin web; nilainya tidak pernah dikembalikan) ----
  api.put('/kenari/key', adminOnly, async (req, res, next) => {
    try {
      const key = String(req.body?.apiKey || '').trim();
      if (!secrets.KEY_RE.test(key)) return res.status(400).json({ error: 'Format API key tidak valid. Key kenari diawali "kn-" tanpa spasi.' });
      const check = await kenari.checkKey(key);
      if (check.state === 'invalid') return res.status(400).json({ error: check.message });
      secrets.setApiKey(key);
      res.json({ ...secrets.keyInfo(), check, verified: check.state === 'valid' || check.state === 'restricted' });
    } catch (e) { next(e); }
  });
  api.delete('/kenari/key', adminOnly, (_req, res, next) => {
    try { secrets.clearApiKey(); res.json(secrets.keyInfo()); } catch (e) { next(e); }
  });
  api.post('/kenari/test', adminOnly, async (req, res, next) => {
    try {
      const cand = req.body?.apiKey ? String(req.body.apiKey).trim() : undefined;
      if (cand && !secrets.KEY_RE.test(cand)) return res.status(400).json({ error: 'Format API key tidak valid' });
      res.json(await kenari.checkKey(cand));
    } catch (e) { next(e); }
  });
  api.post('/share', async (req, res, next) => {
    try {
      const e = await store.getImage(req.body?.id);
      if (!e) return res.status(404).json({ error: 'Gambar tidak ada atau sudah dihapus' });
      res.json(await signedUrl(e, { ttlMinutes: Number(req.body?.ttlMinutes) || 60 }));
    } catch (e) { e.status = e.status || 400; next(e); }
  });
  api.get('/logs', (req, res) => res.json(log.recent({ limit: Number(req.query.limit) || 100, onlyIssues: req.query.issues === '1' })));
  api.get('/models', async (req, res, next) => {
    try { res.json(await kenari.listImageModels({ force: req.query.refresh === '1' })); } catch (e) { next(e); }
  });
  api.get('/estimate', async (req, res, next) => {
    try { res.json(await service.estimate({ model: req.query.model, n: req.query.n, client: req.query.client })); } catch (e) { next(e); }
  });
  api.post('/generate', async (req, res, next) => {
    try { res.json(await service.generateImages({ ...req.body, useStyle: req.body.useStyle ?? true, source: 'web' })); } catch (e) { next(e); }
  });
  api.post('/edit', async (req, res, next) => {
    try {
      const { sourceId, imageBase64, ...rest } = req.body;
      let source;
      if (sourceId) {
        const e = await store.getImage(sourceId);
        if (!e) return res.status(404).json({ error: 'Gambar sumber tidak ada' });
        source = { buffer: await store.readImageFile(e.file), mime: e.mime };
      } else if (imageBase64) {
        const buffer = Buffer.from(imageBase64.replace(/^data:[^,]+,/, ''), 'base64');
        source = { buffer, mime: detectMime(buffer) };
      } else return res.status(400).json({ error: 'Pilih gambar dari galeri atau unggah gambar' });
      res.json(await service.editImages({ ...rest, sources: [source], source: 'web' }));
    } catch (e) { next(e); }
  });
  api.get('/gallery', async (req, res, next) => {
    try { res.json(await store.listImages({ limit: Number(req.query.limit) || 60, query: req.query.q, client: req.query.client === undefined ? undefined : req.query.client === '-' ? '' : String(req.query.client) })); } catch (e) { next(e); }
  });
  api.put('/gallery/:id/keep', async (req, res, next) => {
    try { const e = await store.setKeep(req.params.id, req.body?.keep !== false); e ? res.json(e) : res.status(404).json({ error: 'Gambar tidak ada atau sudah dihapus' }); } catch (e) { next(e); }
  });
  api.get('/styles', (_req, res) => res.json({ styles: styles.list(), clients: styles.clients(), pillars: styles.PILLAR_DRAFTS.map(([n]) => n) }));
  api.post('/styles/seed-pillars', (_req, res, next) => { try { res.json(styles.seedPillars()); } catch (e) { next(e); } });
  api.post('/styles', (req, res, next) => { try { res.status(201).json(styles.create(req.body || {})); } catch (e) { next(e); } });
  api.put('/styles/:id', (req, res, next) => { try { res.json(styles.update(req.params.id, req.body || {})); } catch (e) { next(e); } });
  api.delete('/styles/:id', (req, res, next) => { try { styles.remove(req.params.id); res.json({ ok: true }); } catch (e) { next(e); } });
  app.use('/api', api);

  // File gambar: dilindungi token yang sama; browser memakai ?token= untuk tag <img>.
  app.get('/files/:file', (req, res, next) => {
    if (config.accessToken && !req.headers.authorization && req.query.token) req.headers.authorization = `Bearer ${req.query.token}`;
    auth(req, res, () => res.sendFile(store.imagePath(req.params.file), (err) => err && !res.headersSent && res.status(404).end()));
  });

  // Tautan publik bertanda tangan + kedaluwarsa (untuk Social Hub). Tidak memakai token, hanya tanda tangan.
  app.get('/p/:name', async (req, res) => {
    const id = req.params.name.split('.')[0];
    if (!(await verify(id, req.query.exp, req.query.sig))) return res.status(403).type('text').send('Tautan tidak valid atau sudah kedaluwarsa');
    const entry = await store.getImage(id);
    if (!entry) return res.status(404).type('text').send('Gambar sudah dihapus (masa simpan habis)');
    res.set('Cache-Control', 'private, max-age=300').type(entry.mime);
    res.sendFile(store.imagePath(entry.file), (err) => err && !res.headersSent && res.status(404).end());
  });

  // MCP lewat Streamable HTTP (stateless): hubungkan dari Claude Code / klien MCP remote.
  const mcpHandler = async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
  const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.post('/mcp', bearerOnly, mcpHandler);
  app.all('/mcp', bearerOnly, notAllowed);

  // URL konektor dengan rahasia di path (untuk "Add custom connector" yang hanya meminta URL).
  // Hanya membuka MCP; tidak berlaku untuk web/API. Nonaktif jika MCP_PATH_SECRET kosong/pendek.
  const pathSecret = (req, res, next) => {
    const ok = config.mcpPathSecret.length >= 24 && safeEqual(req.params.secret, config.mcpPathSecret);
    return ok ? next() : res.status(404).type('text').send('Not found');
  };
  app.post('/mcp/:secret', pathSecret, mcpHandler);
  app.all('/mcp/:secret', pathSecret, notAllowed);

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ApprovalRequired) return res.status(402).json({ error: err.message, approvalRequired: true, estimate: err.details });
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status === 401 ? 502 : status).json({ error: err.message });
  });
  return app;
}

if (process.argv[1] === import.meta.filename) {
  await store.init();
  store.startSweeper();
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    const missing = [];
    if (!config.accessToken) missing.push('ACCESS_TOKEN (untuk Claude/MCP)');
    if (config.adminPassword.length < 8) missing.push('ADMIN_PASSWORD (minimal 8 karakter, untuk login web)');
    if (missing.length) {
      console.error(`Wajib diisi di .env jika HOST bukan localhost: ${missing.join(' dan ')}. Berhenti.`);
      process.exit(1);
    }
  }
  createApp().listen(config.port, config.host, () => {
    console.log(`Teman Seller Studio: http://${config.host}:${config.port}  (MCP: /mcp)`);
    if (!secrets.getApiKey()) console.warn('Peringatan: API key kenari belum diisi (isi di Dashboard > Konfigurasi atau KENARI_API_KEY di .env).');
  });
}
