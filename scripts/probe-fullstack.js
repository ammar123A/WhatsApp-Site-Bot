import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import { readdirSync } from 'fs';
import { join } from 'path';

function newestPhoto() {
  const base = './data/photos';
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
  puppeteer: { headless: true, protocolTimeout: 90000, timeout: 60000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-accelerated-2d-canvas', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run'] }
});
client.on('qr', () => { console.log('QR NEEDED'); process.exit(1); });
client.on('auth_failure', (m) => { console.log('AUTH FAIL', m); process.exit(1); });
client.on('ready', async () => {
  try {
    const chatId = '120363412164633402@g.us';
    const media = MessageMedia.fromFilePath(newestPhoto());

    // Run the REAL WWebJS.sendMessage entirely inside the page, capture full stack.
    const result = await client.pupPage.evaluate(async (chatId, mediaInfo) => {
      const out = { ok: false, errMsg: null, stack: [] };
      try {
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });

        const options = { media: { data: mediaInfo.data, mimetype: mediaInfo.mimetype, filename: mediaInfo.filename }, sendSeen: false, linkPreview: false };

        const msg = await window.WWebJS.sendMessage(chat, undefined, options);
        out.ok = true;
        out.id = msg && msg.id;
      } catch (e) {
        out.errMsg = String(e && e.message || e);
        out.stack = String(e && e.stack || '').split('\n').slice(0, 40);
      }
      return out;
    }, chatId, { data: media.data, mimetype: media.mimetype, filename: media.filename });

    console.log('FULL STACK RESULT:');
    console.log('errMsg:', result.errMsg);
    console.log(result.stack.join('\n'));

    await client.destroy();
    process.exit(0);
  } catch (e) { console.log('FATAL', e); process.exit(3); }
});
client.initialize();