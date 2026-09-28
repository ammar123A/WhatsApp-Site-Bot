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

      const ownKeys = Object.getOwnPropertyNames(mediaOptions);

      // build mediaOptions NOT including non-enumerable? Actually spread uses enumerable. Use Object.keys
      const enumKeys = Object.keys(mediaOptions);

      // Test: spread all own props except a single candidate key (leave-one-out) to find culprit(s)
      out.leaveOneOut = {};
      for (const k of enumKeys) {
        try {
          const built = {};
          Object.assign(built, base);
          for (const kk of enumKeys) { if (kk !== k) built[kk] = mediaOptions[kk]; }
          const m = new MsgCls(built);
          out.leaveOneOut[k] = 'ok';
        } catch (e) { out.leaveOneOut[k] = 'ERR: ' + String(e && e.message || e).slice(0, 80); }
      }

      // describe each own prop type
      out.propTypes = {};
      for (const k of enumKeys) {
        let v; try { v = mediaOptions[k]; } catch (e) { v = 'THROW'; }
        if (v && typeof v === 'object') out.propTypes[k] = '<' + v.constructor.name + '>';
        else out.propTypes[k] = 'prim:' + String(v).slice(0, 40);
      }
      return out;
    }, chatId, { data: media.data, mimetype: media.mimetype, filename: media.filename });

    console.log('LEAVE-ONE-OUT RESULTS:');
    console.log(JSON.stringify(result, null, 2));
    await client.destroy();
    process.exit(0);
  } catch (e) { console.log('FATAL', e); process.exit(3); }
});
client.initialize();