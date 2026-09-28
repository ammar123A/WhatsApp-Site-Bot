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
      const out = {};
      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      const MsgCls = window.require('WAWebCollections').Msg.modelClass;
      const { getMaybeMeLidUser, getMaybeMePnUser } = window.require('WAWebUserPrefsMeUser');
      const lidUser = getMaybeMeLidUser();
      const meUser = getMaybeMePnUser();
      const from = (chat.groupMetadata && chat.groupMetadata.isLidAddressingMode) ? lidUser : meUser;
      const participant = window.require('WAWebWidFactory').asUserWidOrThrow(from);
      const newMsgKey = new (window.require('WAWebMsgKey'))({
        from, to: chat.id, id: await (window.require('WAWebMsgKey')).newId(), participant, selfDir: 'out',
      });
      const base = { id: newMsgKey, ack: 0, body: 'x', from, to: chat.id, local: true, self: 'out', t: parseInt(Date.now()/1000), isNewMsg: true, type: 'chat' };

      const mediaOptions = await window.WWebJS.processMediaData(
        { data: mediaInfo.data, mimetype: mediaInfo.mimetype, filename: mediaInfo.filename },
        { sendMediaAsDocument: false });
      mediaOptions.caption = undefined;

      // inspect __x_id
      out.__x_id_dump = (() => { try { const v = mediaOptions.__x_id; return { type: (v && v.constructor && v.constructor.name) || typeof v, keys: v && typeof v === 'object' ? Object.keys(v).slice(0, 20) : null, ser: String(v && (v._serialized || v.id || '')).slice(0, 40), plus: v && v[Symbol.for('WAWebCacheKey')] }; } catch (e) { return 'ERR:' + e.message; } })();

      // toJSON id field?
      out.toJSON_id = (() => { try { const tj = mediaOptions.toJSON(); return { hasId: 'id' in tj, idVal: tj.id }; } catch (e) { return 'ERR'; } })();

      // real lib message assembly then send
      const message = {
        id: newMsgKey, ack: 0, body: undefined, from, to: chat.id, local: true, self: 'out',
        t: parseInt(Date.now()/1000), isNewMsg: true, type: 'chat',
        ...mediaOptions, ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {})
      };

      out.messageOwnKeys = Object.keys(message).length;
      out.has__x_id = '__x_id' in message;
      out.message_id_type = message.id && message.id.constructor && message.id.constructor.name;

      // FIX 1: delete __x_id from the spread object copy before constructing
      const message2 = { ...message };
      delete message2.__x_id;
      try {
        const [msgPromise] = window.require('WAWebSendMsgChatAction').addAndSendMsgToChat(chat, message2);
        const msg = await msgPromise;
        out.fix1_send_ok = true;
        out.fix1_msgId = String(msg && (msg.id && (msg.id._serialized || msg.id.$1 || msg.id))).slice(0, 60);
      } catch (e) {
        out.fix1_send_err = String(e && e.message || e).slice(0, 200);
        out.fix1_send_stack = String(e && e.stack || '').split('\n').slice(0, 8);
      }
      return out;
    }, chatId, { data: media.data, mimetype: media.mimetype, filename: media.filename });

    console.log('__x_id INSPECT + FIX SEND:');
    console.log(JSON.stringify(result, null, 2));
    await client.destroy();
    process.exit(0);
  } catch (e) { console.log('FATAL', e); process.exit(3); }
});
client.initialize();