import config from '../config.js';

// Site photos land in the Supabase Storage bucket under <YYYY-MM-DD>/

const pad = (n) => String(n).padStart(2, '0');

// Some messages come in with msg.id undefined but msg._data.id populated.
// Build a reliable serialized id / media object from whichever exists.
function getMsgId(msg) {
  if (msg.id && msg.id._serialized) return msg.id._serialized;
  const dId = msg._data && msg._data.id;
  if (dId) {
    if (typeof dId === 'string') return dId;
    if (dId._serialized) return dId._serialized;
    if (dId.remote && dId._serialized === undefined) {
      return `${dId.remote}@${dId.server || msg._data.from.split('@')[1] || 'c.us'}`;
    }
  }
  // fallback: build from msg.from + t + id parts
  return null;
}

// Download a photo from a WhatsApp message and upload it to Supabase Storage.
// Throws on failure so the caller can retry.
export async function saveMessagePhoto(msg, injectedClient) {
  let media = null;

  // The message itself carries a reference to the client - most reliable.
  const client = injectedClient || msg.client;
  const msgId = getMsgId(msg);

  // ── Diagnostics ────────────────────────────────────────────────────────
  const diag = {
    hasClient: !!client,
    hasPupPage: !!(client && client.pupPage),
    msgId,
    msgFrom: msg.from,
    hasDirectPath: !!msg._data?.directPath,
    mediaKey: !!msg._data?.mediaKey,
    hasEncFilehash: !!msg._data?.encFilehash,
    hasFilehash: !!msg._data?.filehash,
    _dataKeys: msg._data ? Object.keys(msg._data).slice(0, 30) : []
  };
  console.log(`  → [diag] ${JSON.stringify(diag)}`);

  // ── Method 1: in-page download, using the _data fields if the store
  //    lookup misses. No dependence on msg.id. ────────────────────────────
  if (client && client.pupPage && msg.from) {
    try {
      const d = (msg._data || {});
      const result = await client.pupPage.evaluate(
        async ({ msgId, from, fallbackMedia }) => {
          // Resolve the store message for a full / authoritative object
          let m = null;
          if (msgId) {
            const coll = window.require('WAWebCollections');
            m =
              coll.Msg.get(msgId) ||
              (await coll.Msg.getMessagesById([msgId]))?.messages?.[0];
          }

          const snap = () => m
            ? {
                found: true,
                directPath: !!m.directPath,
                mediaKey: !!m.mediaKey,
                mediaStage: m.mediaData?.mediaStage,
                mimetype: m.mimetype,
                type: m.type,
                hasBlob: !!(m.mediaData && (m.mediaData.mediaBlob || m.mediaData.aa)),
              }
            : { found: false };

          // Prefer store message; fall back to the _data payload
          const have = m || fallbackMedia;

          if (!have) return { ok: false, reason: 'no_message', diag: snap() };

          const tryDownload = async (target) => {
            // 1) Force WhatsApp's own downloader to fetch + decrypt
            if (target && typeof target.downloadMedia === 'function') {
              try {
                await target.downloadMedia({
                  downloadEvenIfExpensive: true,
                  rmrReason: 1,
                });
              } catch (e) { /* try next path */ }
            }

            // 2) Poll for the blob to arrive
            let blob = target?.mediaData && (target.mediaData.mediaBlob || target.mediaData.aa);
            for (let i = 0; i < 12 && !blob; i++) {
              await new Promise(r => setTimeout(r, 1000));
              if (m && window.require) {
                try {
                  const coll2 = window.require('WAWebCollections');
                  const m2 = coll2.Msg.get(msgId);
                  if (m2 && m2.mediaData) blob = m2.mediaData.mediaBlob || m2.mediaData.aa;
                } catch (e) { break; }
              }
            }
            if (blob) return blob;

            // 3) Direct CDN decrypt via WhatsApp's download manager
            if (target && target.directPath && target.mediaKey) {
              const mockQpl = {
                addAnnotations() { return this; },
                addPoint() { return this; },
              };
              try {
                return await window
                  .require('WAWebDownloadManager')
                  .downloadManager.downloadAndMaybeDecrypt({
                    directPath: target.directPath,
                    encFilehash: target.encFilehash,
                    filehash: target.filehash,
                    mediaKey: target.mediaKey,
                    mediaKeyTimestamp: target.mediaKeyTimestamp,
                    type: target.type || 'image',
                    signal: new AbortController().signal,
                    downloadQpl: mockQpl,
                  });
              } catch (e) {
                return { error: 'decrypt_error', err: String(e && e.message || e) };
              }
            }

            return null;
          };

          const mimeType = m?.mimetype || fallbackMedia?.mimetype;

          const res = await tryDownload(have);

          // Turn a successful blob into base64
          if (res && !res.error) {
            let ab;
            if (res instanceof ArrayBuffer) {
              ab = res;
            } else if (res.arrayBuffer) {
              ab = await res.arrayBuffer();
            } else if (res.data) {
              ab = res.data;
            } else {
              return { ok: false, reason: 'unexpected_result', diag: snap() };
            }
            const data = await window.WWebJS.arrayBufferToBase64Async(ab);
            return { ok: true, data, mimetype: mimeType, filename: m?.filename };
          }
          if (res && res.error) {
            return { ok: false, reason: res.error, err: res.err, diag: snap() };
          }

          return { ok: false, reason: 'no_blob', diag: snap() };
        },
        {
          msgId,
          from: msg.from,
          fallbackMedia: {
            directPath: d.directPath,
            encFilehash: d.encFilehash,
            filehash: d.filehash,
            mediaKey: d.mediaKey,
            mediaKeyTimestamp: d.mediaKeyTimestamp,
            type: d.type || 'image',
            mimetype: d.mimetype,
            filename: d.filename,
          },
        }
      );

      if (result && result.ok) {
        media = { data: result.data, mimetype: result.mimetype };
        console.log(`  → direct download OK (${media.mimetype || 'image'})`);
      } else if (result && !result.ok) {
        console.log(`  → direct download: ${result.reason} | ${JSON.stringify(result.diag)} ${result.err ? '| ' + result.err : ''}`);
      }
    } catch (e) {
      console.log(`  → direct download error: ${e.message || e}`);
      media = null;
    }
  } else {
    console.log(`  → method 1 skipped: ${diag.hasClient ? '' : 'no client;'} ${diag.hasPupPage ? '' : 'no pupPage;'} ${diag.msgFrom ? '' : 'no msgFrom;'}`);
  }

  // ── Method 2 (fallback): library downloadMedia() ──────────────────────
  if (!media && msg.downloadMedia) {
    try {
      const dm = await msg.downloadMedia();
      if (dm && dm.data) {
        media = { data: dm.data, mimetype: dm.mimetype };
      } else {
        console.log('  → library downloadMedia returned nothing (mediaStage gate)');
      }
    } catch (e) {
      console.log(`  → library downloadMedia error: ${e.message || e}`);
      media = null;
    }
  }

  if (!media || !media.data) {
    throw new Error('media not available');
  }

  const now = new Date();
  const dayFolder = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  let ext = '.jpg';
  if (media.mimetype) {
    if (media.mimetype.includes('png')) ext = '.png';
    else if (media.mimetype.includes('webp')) ext = '.webp';
    else if (media.mimetype.includes('gif')) ext = '.gif';
  }

  const timestamp = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const filename = `${timestamp}-${now.getTime()}${ext}`;
  const key = `${dayFolder}/${filename}`;

  await uploadPhoto(key, Buffer.from(media.data, 'base64'), media.mimetype || 'image/jpeg');

  return { path: key, dir: dayFolder, filename };
}

// Supabase Storage (REST, private bucket). Photo "paths" in the DB are object
// keys inside the bucket, e.g. 2026-09-28/14-05-11-1790000000000.jpg
const storageUrl = (key) => `${config.supabaseUrl}/storage/v1/object/${config.photoBucket}/${key}`;
const authHeaders = () => ({
  Authorization: `Bearer ${config.supabaseServiceKey}`,
  apikey: config.supabaseServiceKey,
});

// Throws on failure so handlePhoto's retry loop kicks in.
export async function uploadPhoto(key, buffer, mimetype, upsert = false) {
  const res = await fetch(storageUrl(key), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': mimetype, 'x-upsert': String(upsert) },
    body: buffer,
  });
  if (!res.ok) throw new Error(`photo upload failed: ${res.status} ${await res.text()}`);
}

// Returns { data: base64, mimetype, filename } or null if the photo is missing.
export async function downloadPhoto(key) {
  try {
    const res = await fetch(storageUrl(key), { headers: authHeaders() });
    if (!res.ok) {
      console.log(`  ⚠️ Photo ${key} not downloadable: ${res.status}`);
      return null;
    }
    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    return { data, mimetype: res.headers.get('content-type') || 'image/jpeg', filename: key.split('/').pop() };
  } catch (e) {
    console.log(`  ⚠️ Photo ${key} download error: ${e.message || e}`);
    return null;
  }
}
