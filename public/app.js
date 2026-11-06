const $ = (s) => document.querySelector(s);
const SIZES = [['Feed 4:5', '1024x1280'], ['Persegi', '1024x1024'], ['Story 9:16', '1024x1792'], ['Thumbnail 16:9', '1792x1024']];
const TITLES = { dash: 'Dashboard', gen: 'Generate', edit: 'Edit gambar', gal: 'Galeri', config: 'Konfigurasi', budget: 'Batas Biaya', style: 'Style Guide', mcp: 'Koneksi MCP' };
const OK = 'mt-3 text-sm text-success', ERR = 'mt-3 text-sm text-danger', PLAIN = 'mt-3 text-sm';
let cfg, models = [], editSource = null, current = null;

const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const tokenGet = () => store.get('tk'); // hanya untuk server lama tanpa login
const tq = () => (tokenGet() ? `?token=${encodeURIComponent(tokenGet())}` : '');
const rp = (n) => (n === null || n === undefined ? '?' : 'Rp' + Math.round(n).toLocaleString('id-ID'));
const limitText = (n) => (n > 0 ? rp(n) : 'tanpa batas');
const fileUrl = (e) => `${location.origin}/files/${encodeURIComponent(e.file)}`;

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (tokenGet()) headers.Authorization = `Bearer ${tokenGet()}`;
  const res = await fetch(`/api${path}`, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.loginRequired) { location.replace('/login'); throw new Error('Perlu login'); }
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return body;
}
async function copy(text, msgEl, okText = 'URL disalin') {
  try { await navigator.clipboard.writeText(text); msgEl.textContent = okText; }
  catch { window.prompt('Salin manual:', text); }
}

/* ---------- layout ---------- */
function setSidebar(open) {
  $('#sidebar').classList.toggle('-translate-x-full', !open);
  $('#scrim').classList.toggle('hidden', !open);
}
function route() {
  const page = TITLES[location.hash.slice(1)] ? location.hash.slice(1) : 'dash';
  document.querySelectorAll('[data-page]').forEach((s) => (s.hidden = s.dataset.page !== page));
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  $('#page-title').textContent = TITLES[page];
  setSidebar(false);
  if (page === 'gal') loadGallery();
  if (page === 'dash') loadDash();
  if (page === 'budget') loadBudget();
  if (page === 'config') loadConfig();
  if (page === 'style') loadStyles();
}

/* ---------- galeri: grid gambar + nama file + URL ---------- */
function tile(e) {
  const el = document.createElement('div');
  el.className = 'overflow-hidden rounded-xl border border-stroke bg-white shadow-card dark:border-strokedark dark:bg-boxdark';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'block w-full'; btn.onclick = () => openLightbox(e);
  const img = document.createElement('img');
  img.loading = 'lazy'; img.src = `/files/${encodeURIComponent(e.file)}${tq()}`; img.alt = e.prompt || e.file;
  img.className = 'aspect-square w-full bg-graylight object-cover dark:bg-bodydark';
  btn.append(img);
  if (e.client || e.keep) {
    const tags = document.createElement('div'); tags.className = 'flex flex-wrap gap-1 px-3 pt-2';
    if (e.client) tags.append(Object.assign(document.createElement('span'), { className: 'rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-white', textContent: e.client }));
    if (e.keep) tags.append(Object.assign(document.createElement('span'), { className: 'rounded-full bg-success px-2 py-0.5 text-[10px] font-medium text-white', textContent: 'Disimpan' }));
    btn.after(tags);
  }
  const name = document.createElement('div');
  name.className = 'line-clamp-2 break-all px-3 pt-2 text-xs font-medium leading-snug text-bodydark dark:text-white'; name.textContent = e.file; name.title = e.file;
  const url = document.createElement('button');
  url.type = 'button'; url.className = 'block w-full px-3 pb-2 pt-1 text-left text-xs text-primary hover:underline';
  url.textContent = 'Salin URL'; url.title = fileUrl(e);
  url.onclick = async () => { try { await navigator.clipboard.writeText(fileUrl(e)); url.textContent = 'URL disalin ✓'; } catch { window.prompt('Salin manual:', fileUrl(e)); } setTimeout(() => (url.textContent = 'Salin URL'), 1500); };
  el.append(btn, name, url);
  return el;
}

function openLightbox(e) {
  current = e;
  $('#lb-name').textContent = e.file;
  $('#lb-url').textContent = fileUrl(e);
  $('#lb-img').src = `/files/${encodeURIComponent(e.file)}${tq()}`;
  const left = e.expiresAt ? Math.max(0, Math.ceil((new Date(e.expiresAt) - Date.now()) / 86400000)) : null;
  $('#lb-meta').textContent = `${e.client ? `Klien ${e.client} · ` : ''}${e.model} · ${rp(e.costIdr)}${e.keep ? ' · disimpan permanen (tidak dihapus otomatis)' : left !== null ? ` · dihapus permanen ${left} hari lagi` : ''}`;
  $('#lb-keep').textContent = e.keep ? 'Lepas simpan permanen' : 'Simpan permanen';
  $('#lb-prompt').textContent = e.prompt ? `Prompt: ${e.prompt}` : '';
  $('#lb-dl').href = `/files/${encodeURIComponent(e.file)}${tq()}`; $('#lb-dl').download = e.file;
  $('#lb-msg').textContent = '';
  $('#lb').classList.remove('hidden'); $('#lb').classList.add('flex');
}
function closeLightbox() { $('#lb').classList.add('hidden'); $('#lb').classList.remove('flex'); }

function pickEdit(e) {
  editSource = { sourceId: e.id, label: e.file };
  $('#e-src').textContent = `Sumber: ${e.file}`;
  closeLightbox();
  location.hash = '#edit';
}

/* ---------- data ---------- */
function bar(id, spent, limit) {
  const el = $(id); const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
  el.style.width = `${pct}%`;
  el.className = `h-2 rounded-full ${pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-primary'}`;
}
async function refreshConfig() {
  cfg = await api('/config');
  $('#budget-pill').textContent = `${rp(cfg.spentTodayIdr)} / ${limitText(cfg.dailyBudgetIdr)} hari ini`;
  if (cfg.user) { $('#who').textContent = cfg.user; $('#logout').classList.remove('hidden'); }
  document.querySelectorAll('.maxn').forEach((x) => (x.textContent = cfg.maxN));
  const base = cfg.publicUrlSet ? new URL(location.href).origin : location.origin;
  const has = Boolean(cfg.mcpPathSecret);
  $('#mcp-url-wrap').classList.toggle('hidden', !has);
  $('#mcp-url-off').classList.toggle('hidden', has);
  if (has) $('#mcp-url').textContent = `${base}/mcp/${cfg.mcpPathSecret}`;
}

async function loadDash() {
  await refreshConfig().catch(() => {});
  if (!cfg) return;
  for (const [k, spent, limit, label] of [['today', cfg.spentTodayIdr, cfg.dailyBudgetIdr, 'batas harian'], ['week', cfg.spentWeekIdr, cfg.weeklyBudgetIdr, 'batas mingguan'], ['month', cfg.spentMonthIdr, cfg.monthlyBudgetIdr, 'batas bulanan']]) {
    $(`#st-${k}`).textContent = rp(spent);
    $(`#st-${k}-l`).textContent = `${label}: ${limitText(limit)}`;
    bar(`#bar-${k}`, spent, limit);
  }
  $('#st-key').textContent = cfg.hasApiKey ? `API key kenari terisi (${cfg.apiKeyMasked})` : 'API key kenari belum diisi (menu Konfigurasi)';
  $('#st-key').className = `mt-1 text-xs ${cfg.hasApiKey ? 'text-success' : 'text-danger'}`;
  $('#st-retention').textContent = `Gambar sementara: dihapus permanen otomatis setelah ${cfg.retentionDays} hari. Unduh yang masih dipakai.`;
  const items = await api('/gallery?limit=200');
  $('#st-count').textContent = items.length;
  $('#dash-grid').replaceChildren(...items.slice(0, 5).map(tile));
  if (!items.length) $('#dash-grid').textContent = 'Belum ada gambar. Mulai dari menu Generate.';
}

async function loadBudget() {
  await refreshConfig();
  const { settings } = await api('/settings');
  $('#s-cdaily').value = settings.clientDailyBudgetIdr; $('#s-cmonthly').value = settings.clientMonthlyBudgetIdr;
  $('#client-usage').replaceChildren(...(cfg.byClient.length ? cfg.byClient.map((c) => Object.assign(document.createElement('div'), { className: 'flex justify-between border-b border-stroke py-1.5 dark:border-strokedark', textContent: `${c.client}: hari ini ${rp(c.today)} · bulan ini ${rp(c.month)}` })) : [Object.assign(document.createElement('p'), { className: 'text-xs', textContent: 'Belum ada biaya yang tercatat atas nama klien.' })]));
  $('#s-daily').value = settings.dailyBudgetIdr; $('#s-weekly').value = settings.weeklyBudgetIdr; $('#s-monthly').value = settings.monthlyBudgetIdr;
  $('#s-approval').value = settings.approvalThresholdIdr; $('#s-maxn').value = settings.maxN;
  const rows = [['Hari ini', cfg.spentTodayIdr, cfg.dailyBudgetIdr], [`Minggu ini (sejak ${cfg.weekStart})`, cfg.spentWeekIdr, cfg.weeklyBudgetIdr], [`Bulan ini (sejak ${cfg.monthStart})`, cfg.spentMonthIdr, cfg.monthlyBudgetIdr]];
  $('#usage-list').replaceChildren(...rows.map(([label, spent, limit]) => {
    const d = document.createElement('div');
    const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
    d.innerHTML = '<div class="flex justify-between"><span></span><span class="font-medium text-bodydark dark:text-white"></span></div><div class="mt-2 h-2 overflow-hidden rounded-full bg-graylight dark:bg-bodydark"><div class="h-2 rounded-full bg-primary"></div></div>';
    d.querySelector('span').textContent = label;
    d.querySelectorAll('span')[1].textContent = `${rp(spent)} / ${limitText(limit)}`;
    const b = d.querySelector('.bg-primary'); b.style.width = `${pct}%`; if (pct >= 90) b.className = 'h-2 rounded-full bg-danger'; else if (pct >= 70) b.className = 'h-2 rounded-full bg-warning';
    return d;
  }));
  $('#budget-key').textContent = cfg.hasApiKey ? `API key kenari: terisi (${cfg.apiKeyMasked}).` : 'API key kenari belum diisi. Isi di menu Konfigurasi.';
}

/* ---------- konfigurasi: API key + model default ---------- */
let pickModel = '';
const KEY_SRC = { dashboard: 'Dari dashboard', env: 'Dari .env server', none: 'Belum diisi' };
function showKeyInfo(i) {
  const has = i.hasKey ?? i.hasApiKey;
  $('#k-masked').textContent = has ? (i.masked || i.apiKeyMasked) : 'Belum ada key';
  const src = i.source || i.apiKeySource;
  $('#k-source').textContent = KEY_SRC[src] || src;
  $('#k-source').className = `rounded-full px-3 py-1 text-xs font-medium ${src === 'none' ? 'bg-danger text-white' : 'bg-graylight dark:bg-bodydark'}`;
  $('#k-clear').classList.toggle('hidden', src !== 'dashboard');
}
function showCheck(c) {
  const el = $('#k-bal');
  if (c.state === 'valid') { el.className = 'mt-3 text-xs text-success'; el.textContent = `Terhubung. Saldo ${rp(c.balanceIdr)}, tersedia ${rp(c.availableIdr)}.`; }
  else if (c.state === 'restricted') { el.className = 'mt-3 text-xs text-success'; el.textContent = c.message; }
  else { el.className = 'mt-3 text-xs text-danger'; el.textContent = c.message; }
}
function renderModels() {
  const q = $('#m-filter').value.trim().toLowerCase();
  const rows = models.filter((m) => !q || `${m.name} ${m.id}`.toLowerCase().includes(q)).map((m) => {
    const lab = document.createElement('label');
    lab.className = 'flex cursor-pointer items-center gap-3 rounded-lg border border-stroke p-3 text-sm hover:border-primary dark:border-strokedark';
    const r = Object.assign(document.createElement('input'), { type: 'radio', name: 'm-pick', value: m.id, checked: m.id === pickModel });
    r.onchange = () => { pickModel = m.id; $('#m-msg').textContent = ''; };
    const t = document.createElement('div'); t.className = 'min-w-0 flex-1';
    const a = document.createElement('div'); a.className = 'truncate font-medium text-bodydark dark:text-white'; a.textContent = m.name;
    const b = document.createElement('div'); b.className = 'truncate text-xs'; b.textContent = m.id;
    t.append(a, b);
    const p = document.createElement('span'); p.className = `shrink-0 text-xs font-medium ${m.pricePerImageIdr === 0 ? 'text-success' : ''}`;
    p.textContent = m.pricePerImageIdr === 0 ? 'Gratis' : m.pricePerImageIdr === null ? 'harga ?' : `${rp(m.pricePerImageIdr)}/gambar`;
    lab.append(r, t, p);
    return lab;
  });
  $('#m-list').replaceChildren(...rows);
  if (!rows.length) $('#m-list').textContent = models.length ? 'Tidak ada model yang cocok.' : 'Daftar model belum bisa dimuat dari kenari.';
  $('#m-cur').textContent = `Aktif sekarang: ${cfg.defaultModel}`;
}
function fillModelSelects() {
  for (const sel of ['#g-model', '#e-model']) {
    $(sel).replaceChildren(...models.map((m) => Object.assign(document.createElement('option'), { value: m.id, textContent: `${m.name} (${m.pricePerImageIdr === 0 ? 'gratis' : rp(m.pricePerImageIdr)})` })));
    $(sel).value = cfg.defaultModel;
  }
}
async function loadConfig(refresh = false) {
  await refreshConfig();
  showKeyInfo(cfg);
  if (refresh || !models.length) models = await api(`/models${refresh ? '?refresh=1' : ''}`).catch(() => models);
  pickModel = cfg.defaultModel;
  renderModels();
  fb = (await api('/settings')).settings.fallbackModels || [];
  renderFallback();
  loadLogs();
}
function initConfig() {
  initFallback();
  $('#m-filter').oninput = renderModels;
  $('#m-refresh').onclick = async () => { $('#m-msg').className = PLAIN; $('#m-msg').textContent = 'Memuat…'; await loadConfig(true); fillModelSelects(); $('#m-msg').textContent = ''; };
  $('#m-save').onclick = async () => {
    const msg = $('#m-msg');
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify({ defaultModel: pickModel }) });
      await refreshConfig(); fillModelSelects(); renderModels(); renderFallback(); estimate('g'); estimate('e');
      msg.className = OK; msg.textContent = `Model default sekarang ${cfg.defaultModel}. Berlaku untuk web dan Claude.`;
    } catch (e) { msg.className = ERR; msg.textContent = e.message; }
  };
  $('#k-test').onclick = async () => {
    $('#k-bal').className = 'mt-3 text-xs'; $('#k-bal').textContent = 'Mengecek…';
    try { showCheck(await api('/kenari/test', { method: 'POST', body: '{}' })); } catch (e) { showCheck({ state: 'error', message: e.message }); }
  };
  $('#k-save').onclick = async () => {
    const msg = $('#k-msg'), key = $('#k-input').value.trim();
    if (!key) { msg.className = ERR; msg.textContent = 'Tempel API key dulu.'; return; }
    msg.className = PLAIN; msg.textContent = 'Memeriksa key ke kenari…';
    try {
      const r = await api('/kenari/key', { method: 'PUT', body: JSON.stringify({ apiKey: key }) });
      $('#k-input').value = '';
      await refreshConfig(); showKeyInfo(r); showCheck(r.check);
      msg.className = r.verified ? OK : PLAIN;
      msg.textContent = r.verified ? 'Key tersimpan dan sudah dipakai.' : `Key tersimpan, tetapi belum bisa diverifikasi: ${r.check.message}`;
    } catch (e) { msg.className = ERR; msg.textContent = e.message; }
  };
  $('#k-clear').onclick = async () => {
    if (!confirm('Hapus key yang diisi dari dashboard? Server akan memakai KENARI_API_KEY di .env (jika ada).')) return;
    const msg = $('#k-msg');
    try { const r = await api('/kenari/key', { method: 'DELETE' }); await refreshConfig(); showKeyInfo(r); $('#k-bal').textContent = ''; msg.className = OK; msg.textContent = 'Key dashboard dihapus.'; }
    catch (e) { msg.className = ERR; msg.textContent = e.message; }
  };
}

/* ---------- model cadangan + log ---------- */
let fb = [];
function renderFallback() {
  const name = (id) => models.find((m) => m.id === id)?.name || id;
  const rows = fb.map((id, i) => {
    const li = document.createElement('li');
    li.className = 'flex items-center gap-2 rounded-lg border border-stroke p-2 text-sm dark:border-strokedark';
    const t = document.createElement('span'); t.className = 'min-w-0 flex-1 truncate'; t.textContent = `${i + 1}. ${name(id)}`; t.title = id;
    const mk = (label, fn, dis) => Object.assign(document.createElement('button'), { type: 'button', textContent: label, disabled: dis, className: 'rounded border border-stroke px-2 py-1 text-xs disabled:opacity-30 dark:border-strokedark', onclick: fn });
    li.append(t, mk('↑', () => { [fb[i - 1], fb[i]] = [fb[i], fb[i - 1]]; renderFallback(); }, i === 0), mk('↓', () => { [fb[i + 1], fb[i]] = [fb[i], fb[i + 1]]; renderFallback(); }, i === fb.length - 1), mk('✕', () => { fb.splice(i, 1); renderFallback(); }));
    return li;
  });
  $('#f-list').replaceChildren(...rows);
  if (!rows.length) $('#f-list').innerHTML = '<li class="text-sm">Belum ada cadangan. Jika model default gagal, permintaan langsung gagal.</li>';
  const avail = models.filter((m) => m.id !== cfg.defaultModel && !fb.includes(m.id));
  $('#f-add').replaceChildren(...avail.map((m) => Object.assign(document.createElement('option'), { value: m.id, textContent: `${m.name} (${m.pricePerImageIdr === 0 ? 'gratis' : rp(m.pricePerImageIdr)})` })));
  $('#f-add-btn').disabled = !avail.length || fb.length >= 5;
}
const WIB = (iso) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
async function loadLogs() {
  const rows = await api(`/logs?limit=60${$('#l-issues').checked ? '&issues=1' : ''}`).catch(() => []);
  const ST = { ok: ['Berhasil', 'text-success'], error: ['Gagal', 'text-danger'], skipped: ['Dilewati', 'text-warning'] };
  $('#l-list').replaceChildren(...rows.map((r) => {
    const d = document.createElement('div'); d.className = 'rounded-lg border border-stroke p-2 dark:border-strokedark';
    const [label, cls] = ST[r.status] || [r.status, ''];
    const top = document.createElement('div'); top.className = 'flex flex-wrap items-center gap-x-2';
    top.innerHTML = '<b class="status"></b><span class="model font-medium text-bodydark dark:text-white"></span><span class="meta ml-auto"></span>';
    const st = top.querySelector('.status'); st.textContent = label; st.className = `status ${cls}`;
    top.querySelector('.model').textContent = r.model;
    top.querySelector('.meta').textContent = `${WIB(r.at)} · ${r.kind} · ${r.source}${r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s` : ''}`;
    d.append(top);
    const note = [r.fallbackFrom ? `cadangan dari ${r.fallbackFrom}` : '', r.message || ''].filter(Boolean).join(' · ');
    if (note) { const n = document.createElement('div'); n.className = 'mt-1 break-words'; n.textContent = note; d.append(n); }
    return d;
  }));
  if (!rows.length) $('#l-list').textContent = 'Belum ada log.';
}
function initFallback() {
  $('#f-add-btn').onclick = () => { if ($('#f-add').value && fb.length < 5) { fb.push($('#f-add').value); renderFallback(); } };
  $('#f-save').onclick = async () => {
    const msg = $('#f-msg');
    try { await api('/settings', { method: 'PUT', body: JSON.stringify({ fallbackModels: fb }) }); msg.className = OK; msg.textContent = fb.length ? `Tersimpan. Urutan cadangan: ${fb.length} model.` : 'Tersimpan. Cadangan dinonaktifkan.'; }
    catch (e) { msg.className = ERR; msg.textContent = e.message; }
  };
  $('#l-refresh').onclick = loadLogs;
  $('#l-issues').onchange = loadLogs;
}

/* ---------- style guide jamak (per klien) ---------- */
let styleList = [], clientList = [], editingId = null;
const opt = (v, t) => Object.assign(document.createElement('option'), { value: v, textContent: t });
const sameC = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();
// Pemilih style mengikuti klien yang dipilih: klien dipilih = hanya style milik klien itu (gaya Teman Seller tidak ikut).
function fillStylePickers(p) {
  for (const x of p ? [p] : ['g', 'e']) {
    const client = $(`#${x}-client`).value;
    const mine = styleList.filter((s) => sameC(s.client, client));
    const others = mine.filter((s) => !s.base);
    const base = mine.find((s) => s.base);
    const first = base ? `Hanya gaya dasar (${base.name})` : client ? `Klien ${client} belum punya gaya dasar` : 'Tanpa style tambahan';
    const pick = $(`#${x}-style-pick`);
    pick.replaceChildren(...(x === 'e' ? [opt('__none', 'Tanpa Style Guide')] : []), opt('', first), ...others.map((s) => opt(s.name, s.pillar && s.pillar !== s.name ? `${s.name} (${s.pillar})` : s.name)));
  }
  $('#g-style-label').textContent = $('#g-client').value ? `Pakai Style Guide klien ${$('#g-client').value}` : 'Pakai Style Guide Teman Seller';
}
function fillClientSelects() {
  const keep = { g: $('#g-client').value, e: $('#e-client').value, gal: $('#gal-client').value, st: $('#st-filter').value };
  for (const x of ['g', 'e']) $(`#${x}-client`).replaceChildren(opt('', 'Teman Seller (internal)'), ...clientList.map((c) => opt(c, c)));
  $('#gal-client').replaceChildren(opt('', 'Semua klien'), opt('-', 'Teman Seller (internal)'), ...clientList.map((c) => opt(c, c)));
  $('#st-filter').replaceChildren(opt('', 'Teman Seller (internal)'), ...clientList.map((c) => opt(c, c)));
  for (const [id, k] of [['g-client', 'g'], ['e-client', 'e'], ['gal-client', 'gal'], ['st-filter', 'st']]) if ([...$(`#${id}`).options].some((o) => o.value === keep[k])) $(`#${id}`).value = keep[k];
  $('#st-clients').replaceChildren(...clientList.map((c) => Object.assign(document.createElement('option'), { value: c })));
}
function editStyle(st) {
  editingId = st?.id || null;
  $('#st-title').textContent = st ? `Ubah: ${st.name}` : 'Style baru';
  $('#st-client').value = st ? st.client || '' : $('#st-filter').value; $('#st-client').disabled = Boolean(st);
  $('#st-name').value = st?.name || ''; $('#st-pillar').value = st?.pillar || ''; $('#st-text').value = st?.text || ''; $('#st-base').checked = Boolean(st?.base);
  $('#st-del').classList.toggle('hidden', !st); $('#st-msg').textContent = '';
  renderStyleList();
}
function renderStyleList() {
  const rows = styleList.filter((st) => sameC(st.client, $('#st-filter').value)).map((st) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `block w-full rounded-lg border p-3 text-left text-sm hover:border-primary ${st.id === editingId ? 'border-primary' : 'border-stroke dark:border-strokedark'}`;
    const top = document.createElement('div'); top.className = 'flex items-center gap-2';
    const n = document.createElement('span'); n.className = 'min-w-0 flex-1 truncate font-medium text-bodydark dark:text-white'; n.textContent = st.name; top.append(n);
    if (st.base) top.append(Object.assign(document.createElement('span'), { className: 'rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-white', textContent: 'Dasar' }));
    const sub = document.createElement('div'); sub.className = 'mt-1 line-clamp-2 text-xs'; sub.textContent = st.text || '(belum ada teks)';
    const by = document.createElement('div'); by.className = 'mt-1 text-[10px] opacity-70'; by.textContent = `Diubah ${new Date(st.updatedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} oleh ${st.updatedBy === 'web' ? 'Anda (web)' : st.updatedBy}`;
    b.append(top, sub, by); b.onclick = () => editStyle(st);
    return b;
  });
  $('#st-list').replaceChildren(...rows);
  if (!rows.length) $('#st-list').textContent = $('#st-filter').value ? `Klien ${$('#st-filter').value} belum punya style. Klik "+ Style baru" dan buat gaya dasarnya dulu.` : 'Belum ada style. Klik "+ Style baru" atau "Buat dari 7 Content Pillar".';
  $('#st-seed').classList.toggle('hidden', Boolean($('#st-filter').value));
}
async function loadStyles(keepEditing = true) {
  const r = await api('/styles');
  styleList = r.styles; clientList = r.clients;
  $('#st-pillars').replaceChildren(...r.pillars.map((p) => Object.assign(document.createElement('option'), { value: p })));
  fillClientSelects(); fillStylePickers();
  const cur = keepEditing ? styleList.find((x) => x.id === editingId) : null;
  editStyle(cur || null);
}
function initStyles() {
  $('#st-new').onclick = () => editStyle(null);
  $('#st-filter').onchange = () => editStyle(null);
  for (const x of ['g', 'e']) $(`#${x}-client`).onchange = () => { fillStylePickers(x); estimate(x); };
  $('#st-seed').onclick = async () => {
    const r = await api('/styles/seed-pillars', { method: 'POST', body: '{}' });
    $('#st-seed-msg').textContent = r.added.length ? `Ditambahkan ${r.added.length} draf pilar. Periksa dan ubah sesuai selera, lalu setujui sebagai Owner.` : 'Semua pilar sudah ada.';
    await loadStyles();
  };
  $('#st-save').onclick = async () => {
    const msg = $('#st-msg');
    const body = { client: $('#st-client').value, name: $('#st-name').value, pillar: $('#st-pillar').value, text: $('#st-text').value, base: $('#st-base').checked };
    try {
      const saved = editingId ? await api(`/styles/${editingId}`, { method: 'PUT', body: JSON.stringify(body) }) : await api('/styles', { method: 'POST', body: JSON.stringify(body) });
      editingId = saved.id; await loadStyles();
      if (saved.client && $('#st-filter').value !== saved.client) { $('#st-filter').value = saved.client; renderStyleList(); }
      msg.className = OK; msg.textContent = 'Tersimpan.';
    } catch (e) { msg.className = ERR; msg.textContent = e.message; }
  };
  $('#st-del').onclick = async () => {
    if (!editingId || !confirm('Hapus style ini? Tidak bisa dikembalikan.')) return;
    try { await api(`/styles/${editingId}`, { method: 'DELETE' }); editingId = null; await loadStyles(false); $('#st-msg').className = OK; $('#st-msg').textContent = 'Style dihapus.'; }
    catch (e) { $('#st-msg').className = ERR; $('#st-msg').textContent = e.message; }
  };
}

async function estimate(prefix) {
  const model = $(`#${prefix}-model`).value, n = $(`#${prefix}-n`).value || 1, client = $(`#${prefix}-client`).value;
  if (!model) return;
  try {
    const e = await api(`/estimate?model=${encodeURIComponent(model)}&n=${n}&client=${encodeURIComponent(client)}`);
    const sisa = [e.remainingTodayIdr, e.remainingWeekIdr, e.remainingMonthIdr].filter((v) => v !== null);
    if (e.client) { if (e.clientDailyBudgetIdr > 0) sisa.push(Math.max(0, e.clientDailyBudgetIdr - e.spentClientTodayIdr)); if (e.clientMonthlyBudgetIdr > 0) sisa.push(Math.max(0, e.clientMonthlyBudgetIdr - e.spentClientMonthIdr)); }
    $(`#${prefix}-est`).textContent = `Estimasi: ${e.n} × ${rp(e.pricePerImageIdr)} = ${rp(e.totalIdr)}. ` + (sisa.length ? `Sisa budget terendah ${rp(Math.min(...sisa))}.` : 'Tanpa batas budget.') + (e.needsApproval ? ' Butuh persetujuan Owner (melewati ambang).' : '');
    $(`#${prefix}-appr-wrap`).hidden = !e.needsApproval;
  } catch (err) { $(`#${prefix}-est`).textContent = err.message; }
}

async function run(prefix, path, payload, outId) {
  const btn = $(`#${prefix}-go`), msg = $(`#${prefix}-msg`);
  btn.disabled = true; msg.className = PLAIN; msg.textContent = 'Memproses… bisa sampai beberapa menit.';
  try {
    const r = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    msg.className = OK; msg.textContent = `Selesai. ${r.images.length} gambar, biaya ${rp(r.costIdr)}. Tersimpan di Galeri.` + (r.fallbackFrom ? ` Model utama ${r.fallbackFrom} gagal, dipakai cadangan ${r.modelUsed}.` : '');
    $(outId).replaceChildren(...r.images.map(tile));
    if ($('#g-empty')) $('#g-empty').hidden = true;
  } catch (e) { msg.className = ERR; msg.textContent = e.message; }
  finally { btn.disabled = false; refreshConfig().catch(() => {}); estimate(prefix); }
}

async function loadGallery() {
  const f = $('#gal-client').value; // '' semua, '-' hanya Teman Seller, selain itu nama klien
  const items = await api(`/gallery?q=${encodeURIComponent($('#q').value)}${f ? `&client=${encodeURIComponent(f)}` : ''}`);
  $('#gal-grid').replaceChildren(...items.map(tile));
  if (!items.length) $('#gal-grid').textContent = 'Belum ada gambar.';
}

/* ---------- init ---------- */
async function init() {
  $('#burger').onclick = () => setSidebar(true);
  $('#scrim').onclick = () => setSidebar(false);
  $('#theme').onclick = () => { const d = document.documentElement.classList.toggle('dark'); store.set('theme', d ? 'dark' : 'light'); };
  $('#logout').onclick = async () => { await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); location.replace('/login'); };
  $('#token').value = tokenGet();
  $('#mcp-url-copy').onclick = () => copy($('#mcp-url').textContent, $('#mcp-url-msg'), 'URL konektor disalin');
  $('#mcp-http').textContent = `claude mcp add --transport http teman-seller-studio ${location.origin}/mcp --header "Authorization: Bearer <ACCESS_TOKEN>"`;
  $('#token-save').onclick = () => { store.set('tk', $('#token').value); location.reload(); };
  window.addEventListener('hashchange', route);
  $('#lb-close').onclick = closeLightbox;
  $('#lb').onclick = (ev) => { if (ev.target === $('#lb')) closeLightbox(); };
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeLightbox(); });
  $('#lb-edit').onclick = () => pickEdit(current);
  $('#lb-copy').onclick = () => copy(fileUrl(current), $('#lb-msg'));
  $('#lb-keep').onclick = async () => {
    try {
      const r = await api(`/gallery/${current.id}/keep`, { method: 'PUT', body: JSON.stringify({ keep: !current.keep }) });
      current = r; openLightbox(r); $('#lb-msg').textContent = r.keep ? 'Gambar tidak akan dihapus otomatis. Tetap simpan salinan di Drive klien.' : 'Tanda simpan dilepas; hitung mundur 7 hari dimulai.';
      if (location.hash === '#gal') loadGallery();
    } catch (err) { $('#lb-msg').textContent = err.message; }
  };
  $('#lb-share').onclick = async () => {
    try { const r = await api('/share', { method: 'POST', body: JSON.stringify({ id: current.id, ttlMinutes: 60 }) }); await copy(r.url, $('#lb-msg'), `Tautan publik disalin (berlaku sampai ${new Date(r.expiresAt).toLocaleString('id-ID')})`); }
    catch (err) { $('#lb-msg').textContent = err.message; }
  };

  try { await refreshConfig(); } catch (e) {
    if (e.status === 401) { location.hash = '#mcp'; route(); $('#budget-pill').textContent = 'Token diperlukan'; }
    else { $('#budget-pill').textContent = e.message; }
    if (!cfg) return;
  }
  models = await api('/models').catch(() => []);
  fillModelSelects();
  initConfig();
  $('#g-sizes').replaceChildren(...SIZES.map(([l, v]) => Object.assign(document.createElement('button'), {
    type: 'button', className: 'rounded-full border border-stroke px-3 py-1 text-xs text-bodydark hover:border-primary hover:text-primary dark:border-strokedark dark:text-white',
    textContent: `${l} ${v}`, onclick: () => ($('#g-size').value = v),
  })));
  for (const p of ['g', 'e']) { $(`#${p}-model`).onchange = () => estimate(p); $(`#${p}-n`).oninput = () => estimate(p); estimate(p); }
  $('#g-go').onclick = () => run('g', '/generate', {
    prompt: $('#g-prompt').value, model: $('#g-model').value, n: Number($('#g-n').value) || 1, size: $('#g-size').value || undefined,
    title: $('#g-title').value || undefined, background: $('#g-opaque').checked ? 'transparent' : undefined, useStyle: $('#g-style').checked, style: $('#g-style-pick').value || undefined, client: $('#g-client').value || undefined, approved: $('#g-appr').checked,
  }, '#g-out');
  $('#g-five').onclick = () => { $('#g-n').value = Math.min(5, cfg.maxN); estimate('g'); };
  $('#e-file').onchange = async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
    editSource = { imageBase64: data, label: f.name }; $('#e-src').textContent = `Sumber: ${f.name}`;
  };
  $('#e-go').onclick = () => {
    if (!editSource) { $('#e-msg').className = ERR; $('#e-msg').textContent = 'Pilih gambar sumber dulu.'; return; }
    run('e', '/edit', { prompt: $('#e-prompt').value, model: $('#e-model').value, n: Number($('#e-n').value) || 1, title: $('#e-title').value || undefined,
      sourceId: editSource.sourceId, imageBase64: editSource.imageBase64, client: $('#e-client').value || undefined, approved: $('#e-appr').checked, useStyle: $('#e-style-pick').value !== '__none', style: ['', '__none'].includes($('#e-style-pick').value) ? undefined : $('#e-style-pick').value }, '#e-out');
  };
  $('#q').oninput = () => loadGallery();
  $('#gal-client').onchange = () => loadGallery();
  initStyles();
  { const r = await api('/styles'); styleList = r.styles; clientList = r.clients; fillClientSelects(); fillStylePickers(); }

  $('#budget-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = $('#budget-msg');
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify({ dailyBudgetIdr: Number($('#s-daily').value), weeklyBudgetIdr: Number($('#s-weekly').value), monthlyBudgetIdr: Number($('#s-monthly').value), clientDailyBudgetIdr: Number($('#s-cdaily').value), clientMonthlyBudgetIdr: Number($('#s-cmonthly').value), approvalThresholdIdr: Number($('#s-approval').value), maxN: Number($('#s-maxn').value) }) });
      msg.className = OK; msg.textContent = 'Batas biaya tersimpan dan langsung berlaku.'; await loadBudget(); estimate('g'); estimate('e');
    } catch (e) { msg.className = ERR; msg.textContent = e.message; }
  };
  $('#budget-reset').onclick = async () => {
    const { defaults } = await api('/settings');
    const { defaultModel, fallbackModels, ...budgetOnly } = defaults; // model default diatur di menu Konfigurasi
    await api('/settings', { method: 'PUT', body: JSON.stringify(budgetOnly) });
    $('#budget-msg').className = OK; $('#budget-msg').textContent = 'Dikembalikan ke nilai awal dari .env.'; await loadBudget();
  };
  route();
}
init();
