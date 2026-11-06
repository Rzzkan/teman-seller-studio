import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from './config.js';
import * as kenari from './kenari.js';
import * as store from './store.js';
import * as service from './service.js';
import { ApprovalRequired } from './service.js';
import { signedUrl } from './share.js';
import * as settings from './settings.js';
import * as styles from './styles.js';

const baseUrl = () => config.publicUrl || `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
const text = (t) => ({ type: 'text', text: t });
const fail = (t) => ({ isError: true, content: [text(t)] });

async function result(res, returnImages) {
  const lines = res.images.map((e) => `- ${e.id} | ${e.file} | ${baseUrl()}/files/${encodeURIComponent(e.file)}`);
  const fb = res.fallbackFrom ? `PERHATIAN: model utama ${res.fallbackFrom} gagal, hasil dibuat dengan model cadangan ${res.modelUsed}. Alasan: ${res.failures.join(' | ')}\n` : '';
  const content = [text(`${fb}Selesai: ${res.images.length} gambar dengan ${res.modelUsed}, biaya Rp${res.costIdr}.\n${lines.join('\n')}\nSemua gambar tersimpan di galeri: ${baseUrl()}`)];
  if (returnImages) {
    for (const e of res.images) {
      const buf = await store.readImageFile(e.file);
      content.push({ type: 'image', data: buf.toString('base64'), mimeType: e.mime });
    }
  }
  return { content };
}

function wrap(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof ApprovalRequired) return fail(`${e.message}\nEstimasi: ${JSON.stringify(e.details)}`);
      return fail(`Gagal: ${e.message}`);
    }
  };
}

const common = {
  model: z.string().optional().describe(`ID model gambar. Default ${settings.getSync().defaultModel} (diatur Owner di Dashboard > Konfigurasi). Lihat list_image_models.`),
  n: z.number().int().min(1).max(10).optional().describe('Jumlah gambar. Dibatasi pengaturan Dashboard (default 5). Aturan kantor: minta 5 untuk opsi konsep.'),
  size: z.string().optional().describe('Petunjuk ukuran, mis. 1024x1024, 1024x1280 (feed 4:5), 1024x1792 (story). Bukan jaminan.'),
  title: z.string().optional().describe('Judul singkat untuk nama file (YYYY-MM-DD_Role_Judul-Singkat_v1).'),
  role: z.string().optional().describe('Nama peran pembuat untuk nama file, default Kenzo.'),
  approved: z.boolean().optional().describe('Isi true HANYA setelah Owner (Aditya) menyetujui biaya yang melewati ambang.'),
  style: z.string().optional().describe('Nama Style Guide per content pillar (lihat list_style_guides), ditambahkan di atas gaya dasar. Kosong = hanya gaya dasar.'),
  client: z.string().max(60).optional().describe('Nama klien layanan kelola konten. Kosong = pekerjaan Teman Seller sendiri. Jika diisi, HANYA Style Guide milik klien itu yang dipakai (bukan gaya Teman Seller), gambar diberi label klien, dan biaya dihitung per klien.'),
  return_images: z.boolean().optional().describe('Kirim gambar langsung di respons (default true).'),
};

export function buildMcpServer() {
  const server = new McpServer({ name: 'teman-seller-studio', version: '0.1.0' });

  server.registerTool(
    'list_image_models',
    { description: 'Daftar model gambar kenari.id beserta harga per gambar (Rupiah).', inputSchema: {} },
    wrap(async () => {
      const models = await kenari.listImageModels({ force: true });
      return { content: [text(models.map((m) => `${m.id} | ${m.name} | ${m.pricePerImageIdr === null ? 'harga ?' : 'Rp' + m.pricePerImageIdr} | input: ${m.input.join('+')}`).join('\n'))] };
    }),
  );

  server.registerTool(
    'estimate_cost',
    { description: 'Hitung estimasi biaya + sisa budget harian sebelum generate. Tidak mengeluarkan uang.', inputSchema: { model: common.model, n: common.n, client: common.client } },
    wrap(async ({ model, n, client }) => ({ content: [text(JSON.stringify(await service.estimate({ model, n, client }), null, 2))] })),
  );

  server.registerTool(
    'generate_image',
    {
      description:
        'Generate gambar dari teks lewat kenari.id. Hasil disimpan di galeri Teman Seller Studio. Mengeluarkan uang: jika biaya melewati ambang, butuh persetujuan Owner (approved=true).',
      inputSchema: {
        prompt: z.string().min(3).describe('Deskripsi gambar.'),
        background: z.enum(['transparent', 'opaque', 'auto']).optional(),
        use_style_guide: z.boolean().optional().describe('Tambahkan Style Guide Teman Seller ke prompt (default true).'),
        ...common,
      },
    },
    wrap(async (a) =>
      result(
        await service.generateImages({ ...a, useStyle: a.use_style_guide ?? true, source: 'mcp' }),
        a.return_images ?? true,
      ),
    ),
  );

  server.registerTool(
    'edit_image',
    {
      description: 'Edit gambar (image-to-image). Sumber: source_id dari galeri, atau image_base64. Mengeluarkan uang, aturan approval sama dengan generate_image.',
      inputSchema: {
        prompt: z.string().min(3).describe('Perubahan yang diinginkan.'),
        source_id: z.string().optional().describe('ID gambar di galeri.'),
        image_base64: z.string().optional().describe('Gambar sumber base64 (PNG/JPEG/WebP) jika bukan dari galeri.'),
        quality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
        ...common,
      },
    },
    wrap(async (a) => {
      let source;
      if (a.source_id) {
        const e = await store.getImage(a.source_id);
        if (!e) throw new Error(`source_id ${a.source_id} tidak ada di galeri`);
        source = { buffer: await store.readImageFile(e.file), mime: e.mime };
      } else if (a.image_base64) {
        const buffer = Buffer.from(a.image_base64.replace(/^data:[^,]+,/, ''), 'base64');
        source = { buffer, mime: kenari.detectMime(buffer) };
      } else throw new Error('Isi source_id atau image_base64');
      return result(await service.editImages({ ...a, sources: [source], source: 'mcp' }), a.return_images ?? true);
    }),
  );

  server.registerTool(
    'list_gallery',
    {
      description: 'Lihat gambar yang sudah dibuat (terbaru dulu). Bisa dicari lewat kata kunci.',
      inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), client: z.string().max(60).optional().describe('Filter satu klien. Kosong = semua gambar. Isi "-" untuk hanya milik Teman Seller sendiri.') },
    },
    wrap(async ({ query, limit, client }) => {
      const items = await store.listImages({ query, limit: limit ?? 20, client: client === undefined ? undefined : client === '-' ? '' : client });
      return { content: [text(items.length ? items.map((e) => `${e.id} | ${e.file} | ${e.client ? 'klien: ' + e.client : 'Teman Seller'} | ${e.model} | Rp${e.costIdr} | ${e.keep ? 'DISIMPAN (tidak dihapus otomatis)' : 'dihapus ' + e.expiresAt.slice(0, 10)} | ${(e.prompt || '').slice(0, 80)}`).join('\n') : 'Galeri kosong.')] };
    }),
  );

  server.registerTool(
    'get_image',
    { description: 'Ambil satu gambar dari galeri berdasarkan id.', inputSchema: { id: z.string() } },
    wrap(async ({ id }) => {
      const e = await store.getImage(id);
      if (!e) throw new Error('id tidak ditemukan');
      const buf = await store.readImageFile(e.file);
      return { content: [text(`${e.file}\n${e.client ? 'Klien: ' + e.client + '\n' : ''}Prompt: ${e.prompt}\n${e.keep ? 'Ditandai simpan: tidak dihapus otomatis.' : 'Dihapus permanen: ' + e.expiresAt}`), { type: 'image', data: buf.toString('base64'), mimeType: e.mime }] };
    }),
  );

  server.registerTool(
    'get_image_public_url',
    {
      description:
        'Buat tautan HTTPS publik sementara (bertanda tangan) untuk satu gambar di galeri, agar bisa diteruskan ke Social Hub: panggil tool Threads_Hub upload_media dengan source_url = url ini, lalu pakai URL hasilnya di media_urls pada create_post/create_ig_post. Hanya mengunggah ke media library; JANGAN menayangkan/approve tanpa persetujuan Owner. Gambar bersifat sementara (dihapus permanen setelah masa simpan).',
      inputSchema: { id: z.string(), ttl_minutes: z.number().int().min(1).max(1440).optional().describe('Masa berlaku tautan, default 60 menit.') },
    },
    wrap(async ({ id, ttl_minutes }) => {
      const e = await store.getImage(id);
      if (!e) throw new Error('id tidak ditemukan atau gambar sudah dihapus (masa simpan habis)');
      const s = await signedUrl(e, { ttlMinutes: ttl_minutes ?? 60 });
      return { content: [text(`source_url: ${s.url}\nTautan berlaku sampai: ${s.expiresAt}\nBerikutnya: Threads_Hub.upload_media(source_url=<url di atas>, brand=<wardrobe|kids|scarf|daily bila perlu>, filename="${e.file}")`)] };
    }),
  );

  // Style Guide tersimpan di database. Claude bisa mengelolanya langsung lewat MCP (tanpa browser).
  const ACTOR = 'claude (MCP)';
  server.registerTool(
    'list_style_guides',
    { description: 'Daftar Style Guide visual (gaya dasar + gaya per content pillar) dari database. Tanpa `client` = milik Teman Seller; isi `client` untuk Style Guide klien itu. Pakai namanya di parameter `style` pada generate_image/edit_image (dengan `client` yang sama).', inputSchema: { client: z.string().max(60).optional() } },
    wrap(async ({ client }) => {
      const all = styles.list(client ?? '');
      const gone = styles.deletedNames(client ?? '');
      const line = (x) => `${x.base ? '[DASAR] ' : ''}${x.name}${x.pillar ? ` | pilar: ${x.pillar}` : ''} | diubah ${x.updatedAt.slice(0, 16).replace('T', ' ')} UTC oleh ${x.updatedBy} | ${x.text.slice(0, 100)}${x.text.length > 100 ? '…' : ''}`;
      const body = all.length ? all.map(line).join('\n') : `Belum ada Style Guide${client ? ' untuk klien ' + client : ''}. Owner dapat membuatnya di Dashboard > Style Guide, atau Claude lewat set_style_guide.`;
      return { content: [text((client ? `Klien: ${client}\n` : '') + body + (gone.length ? `\nDihapus (bisa dipulihkan dengan restore_style_guide): ${gone.join(', ')}` : ''))] };
    }),
  );

  server.registerTool(
    'get_style_guide',
    { description: 'Baca isi lengkap satu Style Guide. Tanpa `name` = gaya dasar. `client` = Style Guide milik klien (kosong = Teman Seller).', inputSchema: { name: z.string().optional(), client: z.string().max(60).optional() } },
    wrap(async ({ name, client }) => {
      const all = styles.list();
      const s = name ? styles.find(name, all, client ?? '') : styles.getBase(all, client ?? '');
      return { content: [text(s ? `${s.name}${s.pillar ? ` (pilar: ${s.pillar})` : ''}${s.base ? ' [DASAR]' : ''}\n${s.text || '(kosong)'}` : name ? `Style "${name}" tidak ditemukan.` : '(gaya dasar belum diisi)')] };
    }),
  );

  server.registerTool(
    'set_style_guide',
    {
      description: 'Tambah atau ubah satu Style Guide berdasarkan nama (upsert). Tersimpan di database dengan riwayat revisi, jadi bisa dikembalikan. Tanpa `name` = ubah gaya dasar. `base=true` menjadikannya gaya dasar (yang selalu dipakai). Perubahan gaya dasar memengaruhi semua gambar: pastikan sudah disetujui Owner.',
      inputSchema: { text: z.string().max(4000), name: z.string().max(60).optional(), pillar: z.string().max(60).optional(), base: z.boolean().optional(), client: z.string().max(60).optional().describe('Nama klien pemilik Style Guide ini. Kosong = Teman Seller. Klien baru otomatis terdaftar saat Style Guide pertamanya dibuat. Isi brand identity klien (warna, gaya foto, nada visual) di gaya dasarnya.') },
    },
    wrap(async ({ text: t, name, pillar, base, client }) => {
      const all = styles.list();
      const c = styles.normClient(client);
      const existing = name ? styles.find(name, all, c) : styles.getBase(all, c);
      const patch = { text: t, ...(pillar !== undefined ? { pillar } : {}), ...(base !== undefined ? { base } : {}) };
      const saved = existing ? styles.update(existing.id, patch, ACTOR) : styles.create({ name: name || 'Gaya dasar', client: c, ...patch, base: base ?? !name }, ACTOR);
      return { content: [text(`Style guide "${saved.name}"${saved.client ? ` (klien ${saved.client})` : ''} ${existing ? 'diperbarui' : 'dibuat'}${saved.base ? ' (gaya dasar)' : ''}. Riwayat tersimpan; lihat style_guide_history.`)] };
    }),
  );

  server.registerTool(
    'delete_style_guide',
    {
      description: 'Hapus satu Style Guide (hapus lunak: masih bisa dipulihkan dengan restore_style_guide). Aturan kantor: penghapusan butuh persetujuan Owner, jadi isi approved=true HANYA setelah Owner (Aditya) menyetujui.',
      inputSchema: { name: z.string(), client: z.string().max(60).optional(), approved: z.boolean().optional() },
    },
    wrap(async ({ name, client, approved }) => {
      const s = styles.find(name, styles.list(), client ?? '');
      if (!s) throw new Error(`Style "${name}" tidak ditemukan`);
      if (!approved) throw new Error(`Menghapus "${s.name}" butuh persetujuan Owner (Aditya). Minta persetujuan, lalu ulangi dengan approved=true.`);
      styles.remove(s.id, ACTOR);
      return { content: [text(`Style "${s.name}" dihapus (lunak). Pulihkan dengan restore_style_guide.`)] };
    }),
  );

  server.registerTool(
    'style_guide_history',
    { description: 'Riwayat perubahan satu Style Guide (siapa, kapan, isi). Pakai revision id untuk restore_style_guide.', inputSchema: { name: z.string(), client: z.string().max(60).optional(), limit: z.number().int().min(1).max(50).optional() } },
    wrap(async ({ name, client, limit }) => ({
      content: [text(styles.history(name, limit ?? 10, client ?? '').map((r) => `rev ${r.id} | ${r.at.slice(0, 16).replace('T', ' ')} UTC | ${r.action} oleh ${r.actor} | ${r.name} | ${r.text.slice(0, 120)}${r.text.length > 120 ? '…' : ''}`).join('\n'))],
    })),
  );

  server.registerTool(
    'restore_style_guide',
    { description: 'Pulihkan Style Guide yang dihapus (isi name), atau kembalikan isi ke revisi tertentu (isi revision_id dari style_guide_history).', inputSchema: { name: z.string().optional(), client: z.string().max(60).optional(), revision_id: z.number().int().optional() } },
    wrap(async ({ name, client, revision_id }) => {
      if (name === undefined && revision_id === undefined) throw new Error('Isi name atau revision_id');
      const s = styles.restore({ ref: name, revisionId: revision_id, client }, ACTOR);
      return { content: [text(`Style "${s.name}" dipulihkan.`)] };
    }),
  );

  server.registerTool(
    'list_clients',
    { description: 'Daftar klien layanan kelola konten: jumlah Style Guide, jumlah gambar di galeri, dan biaya generate (hari ini + bulan berjalan) per klien. Klien terdaftar otomatis saat Style Guide atau gambar pertamanya dibuat dengan parameter `client`.', inputSchema: {} },
    wrap(async () => {
      const [imgs, spend] = [await store.listImages({ limit: 100000 }), await store.usageByClient()];
      const names = new Map();
      for (const c of styles.clients()) names.set(c.toLowerCase(), c);
      for (const e of imgs) if (e.client) names.set(e.client.toLowerCase(), names.get(e.client.toLowerCase()) || e.client);
      for (const u of spend) names.set(u.client.toLowerCase(), names.get(u.client.toLowerCase()) || u.client);
      if (!names.size) return { content: [text('Belum ada klien. Buat Style Guide klien lewat set_style_guide dengan parameter client.')] };
      const st = settings.getSync();
      const rows = [...names.values()].sort((a, b) => a.localeCompare(b)).map((c) => {
        const u = spend.find((x) => x.client.toLowerCase() === c.toLowerCase());
        const n = imgs.filter((e) => e.client.toLowerCase() === c.toLowerCase());
        return `${c} | ${styles.list(c).length} style | ${n.length} gambar (${n.filter((e) => e.keep).length} disimpan) | biaya hari ini Rp${u?.today ?? 0}, bulan ini Rp${u?.month ?? 0}`;
      });
      return { content: [text(`${rows.join('\n')}\nBatas per klien: harian ${st.clientDailyBudgetIdr || 'tanpa batas'}, bulanan ${st.clientMonthlyBudgetIdr || 'tanpa batas'} (Rp; diatur Owner di Dashboard).`)] };
    }),
  );

  server.registerTool(
    'keep_image',
    { description: 'Tandai gambar (mis. hasil final klien) agar TIDAK dihapus otomatis setelah masa simpan 7 hari, atau lepas tandanya (keep=false; hitung mundur 7 hari mulai saat itu). Untuk arsip jangka panjang tetap simpan salinannya di folder Drive klien.', inputSchema: { id: z.string(), keep: z.boolean().optional().describe('Default true.') } },
    wrap(async ({ id, keep }) => {
      const e = await store.setKeep(id, keep ?? true);
      if (!e) throw new Error('id tidak ditemukan atau gambar sudah dihapus');
      return { content: [text(e.keep ? `${e.file} ditandai simpan: tidak dihapus otomatis.` : `${e.file} dilepas dari tanda simpan; dihapus permanen ${e.expiresAt}.`)] };
    }),
  );

  return server;
}
