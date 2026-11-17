import config from '../config.js';

// Site photos land in the Supabase Storage bucket under <YYYY-MM-DD>/

const pad = (n) => String(n).padStart(2, '0');

// Some messages come in with msg.id undefined but msg._data.id populated.
// Build a reliable serialized id / media object from whichever exists.
// WA Web renamed MsgKey._serialized -> MsgKey.$1, so take either (same
// tolerance the wa-patch uses for sends).
function getMsgKeyId(key) {
  if (!key) return null;
  if (typeof key === 'string') return key;
  return key._serialized ?? key.$1 ?? key;
}

function getMsgId(msg) {
  const fromMsgId = getMsgKeyId(msg.id);
  if (fromMsgId && fromMsgId !== msg.id) return fromMsgId;
  if (msg._data) {
    const dId = getMsgKeyId(msg._data.id);
    if (dId && dId !== msg._data.id) return dId;
  }
  // fallback: build from msg.from + t + id parts
  return null;
}

// Download ANY media from a WhatsApp message - image, document, voice note,
// video. Returns { data (base64), mimetype, filename } or throws.
//
// This used to be the photo-only downloader: the fetch part was always generic
// but the tail hardcoded .jpg, the day folder and the photo bucket, so anything
// that was not an image could never be saved. The fetch part is now exported on
// its own and saveMessagePhoto() below is just the old photo path on top of it.
export async function downloadAnyMedia(msg, injectedClient) {
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

          // Resolve the in-memory (already decrypted) blob for the message.
          // WhatsApp keeps resolved media in WAWebMediaInMemoryBlobCache keyed
          // by filehash, and on the model's mediaObject.mediaBlob. Reading
          // from there avoids re-downloading via the CDN, which on recent WA
          // builds fails with "Unexpected mimetype application/octet-stream".
          const resolveBlob = (targetMsg) => {
            try {
              const cache = window.require('WAWebMediaInMemoryBlobCache')?.InMemoryMediaBlobCache;
              const fh = targetMsg?.mediaObject?.filehash;
              if (cache && fh) {
                const got = cache.get(fh);
                if (got) return got;
              }
            } catch (e) { /* next */ }
            try {
              const mo = targetMsg?.mediaObject;
              if (mo?.mediaBlob && typeof mo.mediaBlob.forceToBlob === 'function') return mo.mediaBlob.forceToBlob();
              if (mo?.mediaBlob) return mo.mediaBlob;
            } catch (e) { /* next */ }
            const md = targetMsg?.mediaData;
            return (md && (md.mediaBlob || md.aa)) || null;
          };

          const tryDownload = async (target) => {
            // 1) Force WhatsApp's own downloader to fetch + decrypt
            let current = target;
            if (current && typeof current.downloadMedia === 'function') {
              try {
                await current.downloadMedia({
                  downloadEvenIfExpensive: true,
                  rmrReason: 1,
                });
              } catch (e) { /* try next path */ }
            }

            // 2) Read the decrypted blob from WhatsApp's in-memory caches
            let blob = resolveBlob(current);
            for (let i = 0; i < 12 && !blob; i++) {
              await new Promise(r => setTimeout(r, 1000));
              if (msgId && window.require) {
                try {
                  const coll2 = window.require('WAWebCollections');
                  const m2 = coll2.Msg.get(msgId);
                  if (m2) current = m2;
                } catch (e) { /* keep current */ }
              }
              blob = resolveBlob(current);
            }
            if (blob) return blob;

            // 3) Direct CDN decrypt via WhatsApp's download manager (last resort)
            if (current && current.directPath && current.mediaKey) {
              const mockQpl = {
                addAnnotations() { return this; },
                addPoint() { return this; },
              };
              try {
                return await window
                  .require('WAWebDownloadManager')
                  .downloadManager.downloadAndMaybeDecrypt({
                    directPath: current.directPath,
                    encFilehash: current.encFilehash,
                    filehash: current.filehash,
                    mediaKey: current.mediaKey,
                    mediaKeyTimestamp: current.mediaKeyTimestamp,
                    type: current.type || 'image',
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
        media = { data: result.data, mimetype: result.mimetype, filename: result.filename };
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
        media = { data: dm.data, mimetype: dm.mimetype, filename: dm.filename };
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

  return media;
}

// Download a photo from a WhatsApp message and upload it to Supabase Storage.
// Throws on failure so the caller can retry.
export async function saveMessagePhoto(msg, injectedClient) {
  const media = await downloadAnyMedia(msg, injectedClient);

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

// Supabase Storage (REST, private buckets). A stored "path" in the DB is the
// object key INSIDE its bucket, e.g. 2026-09-28/14-05-11-1790000000000.jpg
// Every bucket argument defaults to the photo bucket so old callers are safe.
export const storageUrl = (key, bucket = config.photoBucket) =>
  `${config.supabaseUrl}/storage/v1/object/${bucket}/${key}`;

const authHeaders = () => ({
  Authorization: `Bearer ${config.supabaseServiceKey}`,
  apikey: config.supabaseServiceKey,
});

// Create the bucket if it is not there yet, so nobody has to click around in
// the Supabase UI before the bot can file anything. Private bucket, no public
// read: files are fetched through the service key only.
export async function ensureBucket(bucket) {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/bucket/${bucket}`, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (res.ok) return true;

  const created = await fetch(`${config.supabaseUrl}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: bucket,
      name: bucket,
      public: false,
      file_size_limit: config.maxFileBytes,
    }),
  });
  if (created.ok || created.status === 409) {
    console.log(`  🪣 bucket "${bucket}" ready`);
    return true;
  }
  // 400/403 here usually means the bucket exists but is owned elsewhere, or the
  // service key lacks storage admin. Say so instead of failing every upload.
  console.error(`  ⚠️ bucket "${bucket}" not ready: ${created.status} ${await created.text()}`);
  return false;
}

// Throws on failure so the caller's retry loop kicks in.
export async function uploadPhoto(key, buffer, mimetype, upsert = false, bucket = config.photoBucket) {
  const res = await fetch(storageUrl(key, bucket), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': mimetype, 'x-upsert': String(upsert) },
    body: buffer,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
}

// Returns { data: base64, mimetype, filename } or null if the file is missing.
//
// Failures used to be logged as a bare "400" and swallowed, so a photo list would
// happily claim "1 photo" while sending nothing. Now the server's own error body
// is printed and a transient failure is retried, because Supabase does return
// spurious 400s for objects that are sitting there perfectly fine.
export async function downloadPhoto(key, bucket = config.photoBucket) {
  if (!key) return null;
  // Record photo references carry their site bucket explicitly after the
  // per-site bucket migration: "myself-group::photos/26-10-2026/file.jpg".
  // Legacy plain paths still use the supplied/default bucket.
  if (typeof key === 'string' && key.includes('::')) {
    const split = key.indexOf('::');
    bucket = key.slice(0, split);
    key = key.slice(split + 2);
  }
  // Guard against a non-string bucket. `paths.map(downloadPhoto)` passes the array
  // INDEX as the second argument, which silently turned into bucket "0" and made
  // every photo fail with NoSuchBucket. Cheap insurance against that whole class
  // of bug.
  if (typeof bucket !== 'string' || !bucket) bucket = config.photoBucket;
  const url = storageUrl(key, bucket);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: authHeaders() });
      if (res.ok) {
        const data = Buffer.from(await res.arrayBuffer()).toString('base64');
        return { data, mimetype: res.headers.get('content-type') || 'image/jpeg', filename: key.split('/').pop() };
      }

      const body = (await res.text()).slice(0, 200);
      // A missing object will still be missing on the retry - do not bother.
      if (res.status === 404 || /NoSuchKey|not_found/i.test(body)) {
        console.log(`  ⚠️ photo missing from "${bucket}": ${key} (${res.status} ${body})`);
        return null;
      }
      console.log(`  ⚠️ ${key} not downloadable: ${res.status} ${body}${attempt < 2 ? ' - retrying' : ''}`);
    } catch (e) {
      console.log(`  ⚠️ ${key} download error: ${e.message || e}${attempt < 2 ? ' - retrying' : ''}`);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}
