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

    const result = await client.pupPage.evaluate(async (chatId, mediaInfo) => {
      const out = { meUser: null, lidUser: null, chatInfo: null };
      const dump = (o) => {
        if (!o) return String(o);
        const r = {};
        for (const k of Object.keys(o).slice(0, 12)) {
          const v = o[k];
          r[k] = (v && typeof v === 'object') ? ('<' + v.constructor.name + '> ' + String(v._serialized || v.$1 || v.user || v.id || '')) : String(v);
        }
        return r;
      };
      try {
        const { getMaybeMeLidUser, getMaybeMePnUser } = window.require('WAWebUserPrefsMeUser');
        const lidUser = getMaybeMeLidUser && getMaybeMeLidUser();
        const meUser = getMaybeMePnUser && getMaybeMePnUser();
        out.lidUser = dump(lidUser);
        out.meUser = dump(meUser);

        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
        out.chatInfo = {
          isLidMsgDir: chat.id && typeof chat.id.isLid === 'function' ? chat.id.isLid() : 'no-fn',
          isGroup: chat.id && typeof chat.id.isGroup === 'function' ? chat.id.isGroup() : 'no-fn',
          lidAddressingMode: chat.groupMetadata && chat.groupMetadata.isLidAddressingMode,
          id: dump(chat.id),
        };

        // Now try a TEXT send with the exact same path, capture full stack
        try {
          const msg = await window.WWebJS.sendMessage(chat, 'probe sender check', { sendSeen: false, linkPreview: false });
          out.TEXT_ok = true;
          out.TEXT_id = msg && msg.id && (msg.id._serialized || msg.id.$1 || String(msg.id));
        } catch (e) {
          out.TEXT_err = String(e && e.message || e);
          out.TEXT_stack = String(e && e.stack || '').split('\n').slice(0, 10);
        }
      } catch (e) {
        out._fatal = String(e && e.message || e);
        out._fatalStack = String(e && e.stack || '').split('\n').slice(0, 10);
      }
      return out;
    }, chatId, { data: media.data, mimetype: media.mimetype, filename: media.filename });

    console.log('PROBE SENDER RESULT:');
    console.log(JSON.stringify(result, null, 2));

    await client.destroy();
    process.exit(0);
  } catch (e) { console.log('FATAL', e); process.exit(3); }
});
client.initialize();