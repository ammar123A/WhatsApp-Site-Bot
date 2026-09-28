// Instrument Msg.get on the live page, then fire the real library media send,
// and read back whether Msg.get was ever called with an undefined id.
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

    // 1) install instrumentation: wrap Msg.get, record calls
    const installed = await client.pupPage.evaluate(() => {
      const out = { ok: false, err: null, msgType: null, msgKeys: [], getType_before: null };
      try {
        const Msg = window.require('WAWebCollections').Msg;
        out.msgType = typeof Msg;
        out.msgKeys = Object.keys(Msg).slice(0, 40);
        const origGet = Msg.get && Msg.get.bind(Msg);
        out.getType_before = typeof origGet;
        window.__MSG_GET_CALLS = { count: 0, undefinedCount: 0, samples: [] };
        Msg.get = (...a) => {
          window.__MSG_GET_CALLS.count++;
          const arg = a[0];
          if (arg === undefined || arg === null) {
            window.__MSG_GET_CALLS.undefinedCount++;
            if (window.__MSG_GET_CALLS.samples.length < 5) window.__MSG_GET_CALLS.samples.push('UNDEFINED/' + typeof arg);
          } else if (typeof arg === 'object') {
            const k = arg._serialized || arg.id || arg.$1 || 'objNoKey';
            if (window.__MSG_GET_CALLS.samples.length < 5) window.__MSG_GET_CALLS.samples.push('obj:' + String(k).slice(0, 60));
          } else {
            if (window.__MSG_GET_CALLS.samples.length < 5) window.__MSG_GET_CALLS.samples.push('prim:' + String(arg).slice(0, 60));
          }
          return origGet(...a);
        };
        out.ok = true;
      } catch (e) { out.err = String(e && e.message || e); }
      return out;
    });
    console.log('INSTALL:', JSON.stringify(installed, null, 2));

    // 2) warm text with a comment-only, then fire a REAL media send
    const media = MessageMedia.fromFilePath(newestPhoto());
    try {
      const txt = await client.sendMessage(chatId, 'probe-instrument Msg.get check');
      console.log('TEXT ok:', txt && txt.id && (txt.id._serialized || txt.id.id));
    } catch (e) { console.log('TEXT err:', String(e && e.message || e).split('\n')[0]); }

    try {
      const sent = await client.sendMessage(chatId, media, { linkPreview: false });
      console.log('MEDIA ok:', sent && sent.id && (sent.id._serialized || sent.id.id));
    } catch (e) {
      console.log('MEDIA err full:', String(e && e.message || e).split('\n').slice(0, 25).join('\n'));
    }

    // 3) read the instrumentation log
    const log = await client.pupPage.evaluate(() => window.__MSG_GET_CALLS || null);
    console.log('MSG_GET_CALLS:', JSON.stringify(log, null, 2));

    await client.destroy();
    process.exit(0);
  } catch (e) { console.log('FATAL', e); process.exit(3); }
});
client.initialize();