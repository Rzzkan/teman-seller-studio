import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

let secret;
export async function getSecret() {
  if (secret) return secret;
  if (config.signingSecret || config.accessToken) return (secret = config.signingSecret || config.accessToken);
  const f = join(config.dataDir, '.signing-secret');
  if (existsSync(f)) return (secret = (await readFile(f, 'utf8')).trim());
  await mkdir(config.dataDir, { recursive: true });
  secret = randomBytes(32).toString('hex');
  await writeFile(f, secret, { mode: 0o600 });
  return secret;
}

const mac = async (id, exp) => createHmac('sha256', await getSecret()).update(`${id}.${exp}`).digest('hex');

/** URL publik bertanda tangan dan berbatas waktu, untuk dipakai sistem lain (mis. Social Hub) mengambil gambar. */
export async function signedUrl(entry, { ttlMinutes = 60 } = {}) {
  if (!config.publicUrl.startsWith('https://')) {
    throw new Error('PUBLIC_URL (HTTPS) belum diatur. Social Hub hanya bisa mengambil gambar dari URL HTTPS publik, jadi Studio perlu di-deploy dulu (butuh persetujuan Owner) dan PUBLIC_URL diisi di .env.');
  }
  const ttl = Math.min(Math.max(1, Math.floor(ttlMinutes)), 1440);
  const cap = entry.expiresAt ? new Date(entry.expiresAt).getTime() : Infinity; // gambar bertanda simpan tidak punya batas kedaluwarsa
  const exp = Math.min(Date.now() + ttl * 60000, cap);
  const expSec = Math.floor(exp / 1000);
  const ext = entry.file.split('.').pop();
  return { url: `${config.publicUrl}/p/${entry.id}.${ext}?exp=${expSec}&sig=${await mac(entry.id, expSec)}`, expiresAt: new Date(expSec * 1000).toISOString() };
}

export async function verify(id, exp, sig) {
  const e = Number(exp);
  if (!id || !Number.isFinite(e) || e * 1000 < Date.now() || typeof sig !== 'string') return false;
  const want = Buffer.from(await mac(id, e)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
