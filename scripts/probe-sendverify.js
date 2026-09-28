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
    const media = MessageMedia.fromFilePath(newestPhoto());
    // send the media, then inspect the resulting local message in-page to
    // confirm it is a real media message (type image + media object present)
    const info = await client.pupPage.evaluate(async (chatId, mediaInfo) => {
      const out = {};
      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      const options = { media: { data: mediaInfo.data, mimetype: mediaInfo.mimetype, filename: mediaInfo.filename },
                        sendSeen: false, linkPreview: false, waitUntilMsgSent: true };
      const msg = await window.WWebJS.sendMessage(chat, undefined, options);
      out.type = msg && (msg.type || msg.__x_type);
      out.body = msg && String(msg.body || '').slice(0, 30);
      out.hasMedia = !!(msg && msg.media);
      out.mimetype = msg && msg.media && msg.media.mimetype;
      out.size = msg && msg.media && msg.media.size;
      out.id = String(msg && msg.id && (msg.id._serialized || msg.id.$1 || msg.id)).slice(0, 50);
      out.ack = msg && msg.ack;
      return out;
    }, '120363412164633402@g.us', { data: media.data, mimetype: media.mimetype, filename: media.filename });
    console.log('SENT msg:', JSON.stringify(info, null, 2));
    await client.destroy();
    process.exit(0);
  } catch (e) { console.log('FATAL', e); process.exit(3); }
});
client.initialize();