// Diagnostic: try every media-send strategy against the live session and
// report which ones succeed. Uses the same auth/session so state matches the
// real bot. Run while the bot is stopped.
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Newest photo in data/photos
function newestPhoto() {
  const base = './data/photos';
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (let i = dirs.length - 1; i >= 0; i--) {
    const files = readdirSync(join(base, dirs[i])).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
    if (files.length) return join(base, dirs[i], files[files.length - 1]);
  }
  return null;
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  restartOnAuthFail: false,
  authTimeoutMs: 120000,
  puppeteer: {
    headless: true,
    protocolTimeout: 90000,
    timeout: 60000,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-accelerated-2d-canvas',
      '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run'
    ]
  }
});

const photoPath = newestPhoto();
console.log('📸 Sample photo:', photoPath);

client.on('qr', (qr) => { console.log('QR needed - session not restored!'); process.exit(1); });
client.on('auth_failure', (m) => { console.log('AUTH FAIL', m); process.exit(1); });
client.on('ready', async () => {
  try {
    // Resolve group via invite code (authoritative, no heavy getChats).
    let chatId = null;
    let chatLabel = '';
    const inviteCode = (process.env.SITE_GROUP_INVITE || 'LPCqbzUw1RJDQFeQwFwK5S').split('/').pop().split('?')[0].trim();
    for (let attempt = 0; attempt < 3 && !chatId; attempt++) {
      try {
        const info = await client.getInviteInfo(inviteCode);
        chatId = String(info && (info.gid || (info.id && info.id._serialized)) || '');
        chatLabel = info && info.title || '';
        if (chatId) console.log(`🎯 Group via invite: "${chatLabel}" (${chatId})`);
      } catch (e) {
        console.log(`⏳ invite resolve attempt ${attempt + 1} failed: ${e.message}; sleeping...`);
        await sleep(10000);
      }
    }
    if (!chatId) {
      console.log('❌ Could not resolve group - retrying with getChats');
      await sleep(15000);
      const chats = await client.getChats();
      const wanted = (process.env.SITE_GROUP_NAME || 'SiteMate').toLowerCase().trim();
      const target = chats.find(g => g.name && g.name.toLowerCase().trim() === wanted);
      if (!target) { console.log('❌ No group found'); process.exit(2); }
      chatId = target.id._serialized;
      chatLabel = target.name;
      console.log(`🎯 Group via name: "${chatLabel}" (${chatId})`);
    }

    const media = MessageMedia.fromFilePath(photoPath);
    const b64 = readFileSync(photoPath).toString('base64');
    const manualMedia = new MessageMedia('image/jpeg', b64, 'test.jpg');

    const strategies = [
      { name: 'A. fromFilePath, linkPreview:false',
        fn: () => client.sendMessage(chatId, media, { linkPreview: false }) },
      { name: 'B. fromFilePath, linkPreview:false, sendSeen:false',
        fn: () => client.sendMessage(chatId, media, { linkPreview: false, sendSeen: false }) },
      { name: 'C. sendMediaAsDocument:true',
        fn: () => client.sendMessage(chatId, media, { linkPreview: false, sendMediaAsDocument: true }) },
      { name: 'D. text + options.media (caption style)',
        fn: () => client.sendMessage(chatId, '🧪 test D', { linkPreview: false, media }) },
      { name: 'E. manual MessageMedia + caption text',
        fn: () => client.sendMessage(chatId, manualMedia, { linkPreview: false, caption: '🧪 test E' }) },
      { name: 'F. via chat.sendMessage',
        fn: () => target.sendMessage(media, { linkPreview: false, sendSeen: false }) },
      { name: 'G. fromFilePath via options.media, no caption',
        fn: () => client.sendMessage(chatId, undefined, { linkPreview: false, media }) },
    ];

    for (const s of strategies) {
      console.log(`\n── ${s.name} ──`);
      try {
        const r = await Promise.race([
          s.fn(),
          sleep(60000).then(() => { throw new Error('TIMEOUT 60s'); })
        ]);
        console.log(`✅ ${s.name}: OK (id=${r && r.id && r.id._serialized})`);
      } catch (e) {
        console.log(`❌ ${s.name}: FAILED`);
        const msg = String(e && e.message || e);
        console.log('   ', msg.split('\n').slice(0, 2).join(' | '));
      }
      await sleep(4000);
    }
    console.log('\n🏁 Diagnostic done. Exiting.');
    await client.destroy();
    process.exit(0);
  } catch (e) {
    console.log('DIAG ERROR', e);
    process.exit(3);
  }
});

client.initialize();