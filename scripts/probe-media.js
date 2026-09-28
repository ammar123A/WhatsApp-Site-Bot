// Page-level probe: figure out exactly WHY media send crashes.
// 1. WA Web version + MsgKey._serialized vs $1 rename
// 2. processMediaData step-by-step: what does prepRawMedia return?
// 3. getOrCreateMediaObject(filehash) - does it throw the memoize error?
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
    console.log('photo:', photoPath);
    const media = MessageMedia.fromFilePath(photoPath);
    const mediaInfo = { data: media.data, mimetype: media.mimetype, filename: media.filename };

    // ── Probe 1: WA Web version + MsgKey shape ─────────────────────────
    const probe1 = await page.evaluate(() => {
      const out = { wwebVersion: window.Debug?.VERSION || null };
      try {
        const MsgKey = window.require('WAWebMsgKey');
        const k = new MsgKey({ fromMe: true, remote: '120363412164633402@g.us', id: 'ABC123', to: '120363412164633402@g.us' });
        out.msgKey_ownKeys = Object.keys(k);
        out.msgKey_serialized = k._serialized;
        out.msgKey_dollar1 = k.$1;
        out.msgKey_toString = String(k);
        out.msgKey_hasSerializedInProto = '_serialized' in k;
      } catch (e) { out.msgKey_err = String(e && e.message || e); }
      return out;
    });
    console.log('PROBE1 (version/MsgKey):', JSON.stringify(probe1, null, 2));

    // ── Probe 2: processMediaData steps ────────────────────────────────
    const probe2 = await page.evaluate(async (mi) => {
      const out = {};
      const log = (k, v) => { out[k] = v; };
      try {
        const file = window.WWebJS.mediaInfoToFile(mi);
        log('file_type', file.type);
        log('file_size', file.size);
        const OpaqueData = window.require('WAWebMediaOpaqueData');
        const opaqueData = await OpaqueData.createFromData(file, mi.mimetype);
        log('opaque_ok', !!opaqueData);
        const mediaPrep = window.require('WAWebPrepRawMedia').prepRawMedia(opaqueData, { asSticker: false, asGif: false, isPtt: false, asDocument: false });
        const mediaData = await mediaPrep.waitForPrep();
        log('mediaData_keys', Object.keys(mediaData));
        log('mediaData_filehash', mediaData.filehash);
        log('mediaData_type', mediaData.type);
        log('mediaData_mimetype', mediaData.mimetype);
        log('mediaData_isGif', mediaData.isGif);
        try { log('mediaData_toJSON_keys', Object.keys(mediaData.toJSON())); } catch (e) { log('mediaData_toJSON_err', String(e && e.message || e)); }

        // Try getOrCreateMediaObject with whatever filehash is
        try {
          const mediaObject = window.require('WAWebMediaStorage').getOrCreateMediaObject(mediaData.filehash);
          log('getOrCreateMediaObject_OK', !!mediaObject);
          log('mediaObject_keys', mediaObject ? Object.keys(mediaObject) : null);
        } catch (e) {
          log('getOrCreateMediaObject_ERR', String(e && e.message || e));
        }

        // Does getFileHash work as a fallback?
        try {
          const fh = await window.WWebJS.getFileHash(file);
          log('getFileHash_fallback', fh);
        } catch (e) { log('getFileHash_ERR', String(e && e.message || e)); }

        // Does constructing MsgKey for a GROUP message produce _serialized?
        try {
          const MsgKey = window.require('WAWebMsgKey');
          const k = new MsgKey({ fromMe: true, remote: '120363412164633402@g.us', id: 'Z', to: '120363412164633402@g.us' });
          log('group_msgKey_serialized', k._serialized);
          log('group_msgKey_dollar1', k.$1);
          log('group_Msg_get_with_serialized', (() => { try { return !!window.require('WAWebCollections').Msg.get(k._serialized); } catch (e) { return 'ERR:' + String(e && e.message || e); } })());
          log('group_Msg_get_with_dollar1', (() => { try { return !!window.require('WAWebCollections').Msg.get(k.$1); } catch (e) { return 'ERR:' + String(e && e.message || e); } })());
        } catch (e) { log('group_msgKey_err', String(e && e.message || e)); }

        out._ok = true;
      } catch (e) {
        out._fatal = String(e && e.message || e);
        out._stack = String(e && e.stack || '').split('\n').slice(0, 6);
      }
      return out;
    }, mediaInfo);
    console.log('PROBE2 (processMediaData):', JSON.stringify(probe2, null, 2));

    await client.destroy();
    process.exit(0);
  } catch (e) {
    console.log('PROBE ERROR', e);
    process.exit(3);
  }
});

client.initialize();