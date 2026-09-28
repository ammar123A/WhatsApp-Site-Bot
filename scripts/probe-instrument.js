// Instrument the REAL WWebJS.sendMessage path - find exactly which WA modules
// throw "Data passed to getter must include an id property".
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
    const photoPath = newestPhoto();
    const media = MessageMedia.fromFilePath(photoPath);

    // First: send a WARM-UP text so the bot's normal reply path is proven,
    // and the group chat gets loaded into the collection.
    try {
      const wu = await client.sendMessage(chatId, '🛠 probe warmup');
      console.log('TEXT warmup OK:', wu && wu.id && wu.id._serialized);
    } catch (e) {
      console.log('TEXT warmup FAILED:', String(e && e.message || e));
    }

    // Now instrument the page and try a media send via the REAL library path,
    // but wrap suspect modules to capture a full stack.
    const instrumented = await client.pupPage.evaluate(async (chatId, mediaInfo) => {
      const out = {};
      const wrap = (label, modName, meth) => {
        try {
          const mod = window.require(modName);
          const orig = mod[meth];
          if (!orig) { out[label] = { missing: true }; return; }
          mod[meth] = async (...a) => {
            try { return await orig.apply(mod, a); }
            catch (e) {
              const msg = String(e && e.message || e);
              if (/id property|memoize/.test(msg)) {
                out[label] = { threw: msg, stack: String(e && e.stack || '').split('\n').slice(0, 20) };
              }
              throw e;
            }
          };
        } catch (e) { out[label] = { wrapErr: String(e && e.message || e) }; }
      };
      // wrap the candidate modules used in media send + msgkey finalization
      wrap('addAndSendMsgToChat', 'WAWebSendMsgChatAction', 'addAndSendMsgToChat');
      wrap('sendMessageEdit', 'WAWebSendMessageEditAction', 'sendMessageEdit');
      out.MsgModule = (() => { try { const m = window.require('WAWebCollections'); out.Msg_get_t = typeof m.Msg.get; return 'ok'; } catch (e) { return 'ERR:' + String(e && e.message || e); } })();
      // instrument Msg.get manually
      try {
        const m = window.require('WAWebCollections').Msg;
        const origGet = m.get.bind(m);
        m.get = (...a) => {
          if (a[0] === undefined) out.Msg_get_CALLED_WITH_UNDEFINED = true;
          return origGet(...a);
        };
        out.Msg_get_instrumented = typeof m.get;
      } catch (e) { out.Msg_get_instrument = 'ERR:' + String(e && e.message || e); }

      try {
        // replicate Client.sendMessage evaluate body
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
        out.chatType = typeof chat;
        out.chatIsCached = !!chat;
        if (!chat) { out._fail = 'no chat in collection'; return out; }
        const msg = await window.WWebJS.sendMessage(chat, '', {
          media: mediaInfo, caption: 'probe', linkPreview: undefined,
          sendMediaAsSticker: undefined, sendMediaAsDocument: undefined,
          sendVideoAsGif: undefined, sendAudioAsVoice: undefined,
          sendMediaAsHd: undefined, parseVCards: true, mentionedJidList: [],
        });
        out.sendOk = true;
        out.id = msg && msg.id && (msg.id._serialized || msg.id);
      } catch (e) {
        out._fatal = String(e && e.message || e);
        out._fatalStack = String(e && e.stack || '').split('\n').slice(0, 20);
      }
      return out;
    }, chatId, { data: media.data, mimetype: media.mimetype, filename: media.filename });

    console.log(JSON.stringify(instrumented, null, 2));
    await client.destroy();
    process.exit(0);
  } catch (e) { console.log('FATAL', e); process.exit(3); }
});
client.initialize();