import { mkdir, readFile, writeFile, rename, readdir, rm, stat, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const imagesDir = () => join(config.dataDir, 'images');
const indexFile = () => join(config.dataDir, 'index.json');
const ledgerFile = () => join(config.dataDir, 'ledger.jsonl');

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// Tanggal WIB (Asia/Jakarta) dalam format YYYY-MM-DD.
export function wibDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function slugify(text, max = 40) {
  return (
    String(text || 'Gambar')
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join('-')
      .slice(0, max) || 'Gambar'
  );
}

// Serialisasi tulis index agar request paralel tidak saling menimpa.
let chain = Promise.resolve();
const locked = (fn) => (chain = chain.then(fn, fn));

async function readIndex() {
  if (!existsSync(indexFile())) return [];
  return JSON.parse(await readFile(indexFile(), 'utf8'));
}

async function writeIndex(entries) {
  const tmp = indexFile() + '.tmp';
  await writeFile(tmp, JSON.stringify(entries, null, 2));
  await rename(tmp, indexFile());
}

/**
 * Buku biaya: baris kecil per batch (tanggal WIB + rupiah), TIDAK ikut dihapus oleh retensi gambar,
 * supaya total mingguan/bulanan tetap akurat walau gambarnya sudah dihapus.
 */
async function ensureLedger() {
  if (existsSync(ledgerFile())) return;
  const rows = (await readIndex()).filter((e) => e.costIdr > 0).map((e) => ({ at: e.createdAt, date: e.date, costIdr: e.costIdr, model: e.model, batch: e.batch, client: e.client || '' }));
  await writeFile(ledgerFile(), rows.map((r) => JSON.stringify(r) + '\n').join(''));
}
async function readLedger() {
  await ensureLedger();
  return (await readFile(ledgerFile(), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
export function weekStartOf(dateStr) { // Senin pekan berjalan (WIB)
  const d = new Date(dateStr + 'T00:00:00Z');
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86400000).toISOString().slice(0, 10);
}
const sameClient = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
// usage() = total semua; usage(client) = hanya klien itu ('' = Teman Seller sendiri).
export async function usage(client) {
  const rows = (await readLedger()).filter((r) => client === undefined || sameClient(r.client, client));
  const today = wibDate(), ws = weekStartOf(today), ms = today.slice(0, 8) + '01';
  const sum = (f) => rows.filter(f).reduce((a, r) => a + (r.costIdr || 0), 0);
  return { today: sum((r) => r.date === today), week: sum((r) => r.date >= ws), month: sum((r) => r.date >= ms), weekStart: ws, monthStart: ms };
}
// Rekap biaya per klien (hari ini + bulan berjalan) untuk laporan/tagihan internal. Teman Seller sendiri = '' dan tidak ikut daftar.
export async function usageByClient() {
  const rows = (await readLedger()).filter((r) => r.client);
  const today = wibDate(), ms = today.slice(0, 8) + '01';
  const out = new Map();
  for (const r of rows) {
    const k = r.client.trim();
    const o = out.get(k.toLowerCase()) || { client: k, today: 0, month: 0 };
    if (r.date === today) o.today += r.costIdr || 0;
    if (r.date >= ms) o.month += r.costIdr || 0;
    out.set(k.toLowerCase(), o);
  }
  return [...out.values()].sort((a, b) => b.month - a.month);
}

export async function init() {
  await mkdir(imagesDir(), { recursive: true });
}

/** Simpan satu batch gambar. Nama file: YYYY-MM-DD_Role_Judul-Singkat_v1_01.ext (aturan kantor, bagian 3). */
export function saveBatch({ images, meta }) {
  return locked(async () => {
    await init();
    await ensureLedger(); // backfill dari index lama sebelum entri baru ditambahkan
    const entries = await readIndex();
    const date = wibDate();
    const role = slugify(meta.role || 'Kenzo', 20);
    const title = slugify(meta.title || meta.prompt);
    const prefix = `${date}_${role}_${title}`;
    let version = 1;
    while (entries.some((e) => e.file.startsWith(`${prefix}_v${version}_`))) version++;
    const saved = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const file = `${prefix}_v${version}_${String(i + 1).padStart(2, '0')}.${EXT[img.mime] || 'png'}`;
      await writeFile(join(imagesDir(), file), img.buffer);
      const entry = {
        id: randomUUID().slice(0, 8),
        file,
        mime: img.mime,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + config.retentionDays * 86400000).toISOString(),
        date,
        kind: meta.kind,
        model: meta.model,
        prompt: meta.prompt,
        finalPrompt: meta.finalPrompt,
        title: meta.title || null,
        size: meta.size || null,
        source: meta.source || 'web',
        style: meta.style || null,
        client: meta.client || '',
        keep: false,
        // biaya dibagi rata per gambar; biaya batch dicatat di gambar pertama agar total tetap akurat
        costIdr: i === 0 ? meta.costIdr : 0,
        batch: `${prefix}_v${version}`,
      };
      entries.push(entry);
      saved.push(entry);
    }
    await writeIndex(entries);
    if (meta.costIdr > 0) await appendFile(ledgerFile(), JSON.stringify({ at: new Date().toISOString(), date, costIdr: meta.costIdr, model: meta.model, batch: `${prefix}_v${version}`, client: meta.client || '' }) + '\n');
    return saved;
  });
}

const expiryOf = (e) => new Date(e.expiresAt || new Date(e.createdAt).getTime() + config.retentionDays * 86400000);
// Gambar bertanda "simpan" (keep) tidak ikut retensi: expiresAt null, tidak pernah disapu.
export const isExpired = (e, now = Date.now()) => !e.keep && expiryOf(e).getTime() <= now;
export const withExpiry = (e) => ({ ...e, client: e.client || '', keep: Boolean(e.keep), expiresAt: e.keep ? null : expiryOf(e).toISOString() });

/** Tandai/lepas tanda simpan: hasil final klien yang perlu bertahan lebih dari masa retensi. */
export function setKeep(id, keep) {
  return locked(async () => {
    const entries = await readIndex();
    const e = entries.find((x) => x.id === id);
    if (!e || isExpired(e)) return null;
    e.keep = Boolean(keep);
    if (!e.keep) e.expiresAt = new Date(Date.now() + config.retentionDays * 86400000).toISOString(); // mulai hitung mundur dari sekarang
    await writeIndex(entries);
    return withExpiry(e);
  });
}

// client: undefined = semua; '' = hanya Teman Seller; 'Toko A' = hanya klien itu.
export async function listImages({ limit = 50, query, client } = {}) {
  let entries = (await readIndex()).filter((e) => !isExpired(e)).map(withExpiry).reverse();
  if (client !== undefined) entries = entries.filter((e) => sameClient(e.client, client));
  if (query) {
    const q = query.toLowerCase();
    entries = entries.filter((e) => `${e.title} ${e.prompt} ${e.file}`.toLowerCase().includes(q));
  }
  return entries.slice(0, limit);
}

export async function getImage(id) {
  const e = (await readIndex()).find((x) => x.id === id);
  if (!e || isExpired(e)) return null;
  return withExpiry(e);
}

export function imagePath(file) {
  return join(imagesDir(), basename(file)); // basename mencegah path traversal
}

export async function readImageFile(file) {
  return readFile(imagePath(file));
}

export async function spentToday() {
  return (await usage()).today;
}

export async function countFiles() {
  return existsSync(imagesDir()) ? (await readdir(imagesDir())).length : 0;
}

/**
 * Hapus permanen gambar yang lewat masa simpan (default 7 hari) beserta file yatim di disk.
 * Yang disimpan hanya jejak audit kecil (id, nama file, waktu) di data/deleted.log, bukan gambarnya.
 */
export function sweep({ now = Date.now() } = {}) {
  return locked(async () => {
    await init();
    const entries = await readIndex();
    const keep = [], gone = [];
    for (const e of entries) (isExpired(e, now) ? gone : keep).push(e);
    for (const e of gone) await rm(imagePath(e.file), { force: true });
    const known = new Set(keep.map((e) => e.file));
    let orphans = 0;
    for (const f of await readdir(imagesDir())) {
      if (known.has(f) || gone.some((e) => e.file === f)) continue;
      const st = await stat(join(imagesDir(), f));
      if (now - st.mtimeMs > config.retentionDays * 86400000) { await rm(join(imagesDir(), f), { force: true }); orphans++; }
    }
    if (gone.length) {
      await writeIndex(keep);
      await appendFile(join(config.dataDir, 'deleted.log'), gone.map((e) => JSON.stringify({ id: e.id, file: e.file, createdAt: e.createdAt, deletedAt: new Date(now).toISOString() })).join('\n') + '\n');
    }
    return { deleted: gone.length, orphans };
  });
}

export function startSweeper(intervalMs = 3600000) {
  const run = () => sweep().then((r) => (r.deleted || r.orphans) && console.log(`Retensi: ${r.deleted} gambar + ${r.orphans} file yatim dihapus permanen`)).catch((e) => console.error('sweep gagal', e.message));
  run();
  const t = setInterval(run, intervalMs);
  t.unref();
  return t;
}
