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

      out.mediaKeys_props = Object.keys(mediaOptions).slice(0, 60);
      out.mediaKeys_own = (() => { try { return Object.getOwnPropertyNames(mediaOptions).slice(0, 60); } catch(e){ return ['ERR:'+e.message]; } })();

      // toJSON result keys
      out.toJSON_keys = (() => { try { const t = mediaOptions.toJSON ? mediaOptions.toJSON() : null; return t ? Object.keys(t) : ['no-toJSON']; } catch (e) { return ['ERR:' + String(e.message).slice(0,120)]; } })();

      // try building with ONLY toJSON() content
      try {
        const tj = mediaOptions.toJSON ? mediaOptions.toJSON() : {};
        const m = new MsgCls({ ...base, ...tj });
        out.onlyToJSON_ok = true;
        out.captionAfter = m.caption;
      } catch (e) { out.onlyToJSON_err = String(e && e.message || e).slice(0, 200); }

      // try building with spread model + no toJSON
      try {
        const m = new MsgCls({ ...base, ...mediaOptions });
        out.spreadOnly_ok = true;
      } catch (e) { out.spreadOnly_err = String(e && e.message || e).slice(0, 200); }

      // try with mediaObject only
      try {
        const mo = mediaOptions.mediaObject;
        const m = new MsgCls({ ...base, mediaObject: mo });
        out.mediaObjectOnly_ok = true;
        out.mediaObjectType = mo ? mo.constructor.name : 'n/a';
      } catch (e) { out.mediaObjectOnly_err = String(e && e.message || e).slice(0, 200); }

      // try with each toJSON key added one by one
      const tjKeys = (() => { try { return Object.keys(mediaOptions.toJSON ? mediaOptions.toJSON() : {}); } catch(e){ return []; } })();
      out.perKey = {};
      for (const k of tjKeys.slice(0, 40)) {
        try {
          const tj = mediaOptions.toJSON();
          const m = new MsgCls({ ...base, [k]: tj[k] });
          out.perKey[k] = 'ok';
        } catch (e) { out.perKey[k] = 'ERR: ' + String(e && e.message || e).slice(0, 90); }
      }
      return out;
    }, chatId, { data: media.data, mimetype: media.mimetype, filename: media.filename });

    console.log('FIELD BISECT RESULTS:');
    console.log(JSON.stringify(result, null, 2));
    await client.destroy();
    process.exit(0);
  } catch (e) { console.log('FATAL', e); process.exit(3); }
});
client.initialize();