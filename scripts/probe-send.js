// Probe: reproduce the EXACT library media-send evaluate, instrumented.
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  puppeteer: {
    headless: true,
    protocolTimeout: 90000,
    timeout: 60000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-accelerated-2d-canvas', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run']
  }
});

client.on('qr', () => { console.log('QR NEEDED - abort'); process.exit(1); });
client.on('auth_failure', (m) => { console.log('AUTH FAIL', m); process.exit(1); });
client.on('ready', async () => {
  try {
    const page = client.pupPage;
    const photoPath = newestPhoto();
    const media = MessageMedia.fromFilePath(photoPath);
    const chatId = '120363412164633402@g.us';

    // Mirror Client.sendMessage exactly but instrument each step.
    const result = await page.evaluate(async (chatId, mediaInfo, sendSeen) => {
      const out = {};
      const internalOptions = {
        linkPreview: undefined,
        sendAudioAsVoice: undefined,
        sendVideoAsGif: undefined,
        sendMediaAsSticker: undefined,
        sendMediaAsDocument: undefined,
        sendMediaAsHd: undefined,
        caption: 'probe',
        isCaptionByUser: true,
        quotedMessageId: undefined,
        parseVCards: true,
        mentionedJidList: [],
        groupMentions: undefined,
        invokedBotWid: undefined,
        ignoreQuoteErrors: true,
        waitUntilMsgSent: false,
        media: mediaInfo,
        isViewOnce: undefined,
      };

      const step = (name, fn) => Promise.resolve().then(fn).then(v => (out[name] = v)).catch(e => { out[name] = 'ERR:' + String(e && e.message || e); return null; });

      try {
        const chat = await step('chat_get', () => window.WWebJS.getChat(chatId, { getAsModel: false }));
        out.chatFound = !!chat;
        if (!chat || typeof chat !== 'object') return { ...out, _fail: 'no chat' };

        if (sendSeen) { out.sendSeenErr = await step('sendSeen', () => window.WWebJS.sendSeen(chatId)); }

        // Manually reproduce WWebJS.sendMessage's media prep
        await step('processMediaData', async () => {
          const mo = await window.WWebJS.processMediaData(mediaInfo, {
            forceSticker: undefined, forceGif: undefined, forceVoice: undefined,
            forceDocument: undefined, forceMediaHd: undefined,
            sendToChannel: false, sendToStatus: false,
          });
          mo.caption = 'probe';
          mo.isViewOnce = undefined;
          return { filehash: mo.filehash, type: mo.type };
        });

        // Build the msg key exactly like the library
        await step('msgkey_getFromMe', async () => {
          const { getMaybeMeLidUser, getMaybeMePnUser } = window.require('WAWebUserPrefsMeUser');
          const lidUser = getMaybeMeLidUser();
          return { lidOk: !!lidUser, lidType: typeof lidUser };
        });
        await step('msgkey_newId', () => window.require('WAWebMsgKey').newId());
        const newId = out.msgkey_newId;
        if (typeof newId === 'string') {

        const newMsgKey = await step('msgkey_build', async () => {
          const { getMaybeMeLidUser, getMaybeMePnUser } = window.require('WAWebUserPrefsMeUser');
          const lidUser = getMaybeMeLidUser();
          const meUser = getMaybeMePnUser();
          let from = chat.id.isLid() ? lidUser : meUser;
          let participant;
          if (typeof chat.id?.isGroup === 'function' && chat.id.isGroup()) {
            from = chat.groupMetadata && chat.groupMetadata.isLidAddressingMode ? lidUser : meUser;
            participant = window.require('WAWebWidFactory').asUserWidOrThrow(from);
          }
          const k = new (window.require('WAWebMsgKey'))({ from, to: chat.id, id: newId, participant, selfDir: 'out' });
          return {
            ownKeys: Object.keys(k),
            serialized: k._serialized,
            dollar1: k.$1,
            toString: String(k),
            cloneSerialized: (() => { try { return k.clone()._serialized; } catch (e) { return 'cloneERR'; } })(),
          };
        });
        out.newMsgKey = newMsgKey;
        out.newMsgKeyOk = true;
        // Final lookups the library does
        const nk = out.newMsgKey;
        if (nk && nk.serialized) {
          out.msgGet_serialized = (() => { try { const m = window.require('WAWebCollections').Msg.get(nk.serialized); return !!m; } catch (e) { return 'ERR:' + String(e && e.message || e); } })();
        } else {
          out.msgGet_serialized = 'skipped (serialized missing)';
        }
        if (nk && nk.dollar1) {
          out.msgGet_dollar1 = (() => { try { const m = window.require('WAWebCollections').Msg.get(nk.dollar1); return !!m; } catch (e) { return 'ERR:' + String(e && e.message || e); } })();
        } else {
          out.msgGet_dollar1 = 'skipped (dollar1 missing)';
        }
        }
        out._ok = true;
      } catch (e) {
        out._fatal = String(e && e.message || e);
        out._stack = String(e && e.stack || '').split('\n').slice(0, 8);
      }
      return out;
    }, { data: media.data, mimetype: media.mimetype, filename: media.filename }, true);

    console.log(JSON.stringify(result, null, 2));
    await client.destroy();
    process.exit(0);
  } catch (e) {
    console.log('PROBE ERROR', e);
    process.exit(3);
  }
});

client.initialize();