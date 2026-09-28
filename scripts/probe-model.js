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
      const snap = (o, n) => {
        out[n] = {};
        for (const k of Object.keys(o || {}).slice(0, 14)) {
          let v;
          try { v = o[k]; } catch (e) { v = '<getter-throw:' + e.message.slice(0, 30) + '>'; }
          if (v && typeof v === 'object' && v.constructor) {
            const s = String(v._serialized || v.id || '');
            out[n][k] = '<' + v.constructor.name + '>' + (s ? ' ' + s : '');
          } else out[n][k] = String(v).slice(0, 50);
        }
      };
      try {
        // text message model inspect
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
        const message = { id: newMsgKey, ack: 0, body: 'x', from, to: chat.id, local: true, self: 'out', t: parseInt(Date.now()/1000), isNewMsg: true, type: 'chat' };

        // Can we construct the Msg model for TEXT?
        try {
          const m = new MsgCls(message);
          snap(m, 'textMsgModel');
          try { out.text_getSender = m.getSender ? m.getSender(chat) : 'no-fn'; snap(out.text_getSender, 'text_sender'); }
          catch (e) { out.text_getSender_err = String(e && e.message || e).slice(0, 200); }
          try { out.text_getValidatedSender = m.getValidatedSender ? String(m.getValidatedSender(chat)) : 'no-fn'; }
          catch (e) { out.text_getValidated_err = String(e && e.message || e).slice(0, 200); }
        } catch (e) { out.text_model_err = String(e && e.message || e).slice(0, 200); }

        // Now WITH mediaOptions -> same as real path
        try {
          const mediaOptions = await window.WWebJS.processMediaData(
            { data: mediaInfo.data, mimetype: mediaInfo.mimetype, filename: mediaInfo.filename },
            { sendMediaAsDocument: false });
          mediaOptions.caption = undefined;
          snap(mediaOptions, 'mediaOptions');
          const msg2 = new MsgCls({ ...message, ...mediaOptions, ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}) });
          snap(msg2, 'mediaMsgModel');
          try { out.media_getSender = msg2.getSender ? msg2.getSender(chat) : 'no-fn'; }
          catch (e) { out.media_getSender_err = String(e && e.message || e).slice(0, 300); }
        } catch (e) { out.media_model_err = String(e && e.message || e).slice(0, 300); out.media_model_stack = String(e && e.stack || '').split('\n').slice(0,6); }
      } catch (e) {
        out._fatal = String(e && e.message || e);
        out._fatalStack = String(e && e.stack || '').split('\n').slice(0, 8);
      }
      return out;
    }, chatId, { data: media.data, mimetype: media.mimetype, filename: media.filename });

    console.log('MODEL COMPARISON:');
    console.log(JSON.stringify(result, null, 2));

    await client.destroy();
    process.exit(0);
  } catch (e) { console.log('FATAL', e); process.exit(3); }
});
client.initialize();