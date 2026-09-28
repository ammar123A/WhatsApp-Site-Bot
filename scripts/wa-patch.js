// Idempotent boot-time patch for whatsapp-web.js 1.34.7 + WA Web >= 2.3000.1042.
//
// Two known-regression fixes applied to the library's injected Utils.js:
//   1. Media sends crash with
//        "Data passed to getter must include an id property (it's how we
//         memoize) but got undefined"
//      because the MediaData model's `__x_id` (a `{sentinel}` object) collides
//      with the Msg model's id slot when spread into the outbound message.
//   2. WA Web renamed MsgKey._serialized -> MsgKey.$1, so Msg.get(newMsgKey
//      ._serialized) returns undefined and client.sendMessage() returns a
//      Message with no usable id. Fall back to the $1 key.
//
// Runs on every boot BEFORE the client is constructed; safe to run repeatedly.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const utilsPath = resolve(here, '../node_modules/whatsapp-web.js/src/util/Injected/Utils.js');

const MARKER = 'SiteBot wa-web media-send patch';

export function patchWawWebInjected() {
  if (!existsSync(utilsPath)) {
    console.log('⚠️  [wa-patch] Utils.js not found - skipping patch. (npm install missing?)');
    return { applied: false, reason: 'file-not-found' };
  }
  let src = readFileSync(utilsPath, 'utf8');

  if (src.includes(MARKER)) {
    return { applied: false, reason: 'already-patched' };
  }

  const results = { textReturn: false, editReturn: false, mediaId: false, helper: false };
  let msgs = [];

  // ── Fix 4: expose getMsgKeyId helper (used by fix 1/2) ──
  // Run FIRST so the existence check isn't fooled by references we add below.
  const helperAnchor = "window.WWebJS.sendMessage = async (chat, content, options = {}) => {";
  const helperDef = "window.WWebJS.getMsgKeyId = (key) => key?._serialized ?? key?.$1 ?? key;";
  if (src.includes(helperAnchor) && !src.includes(helperDef)) {
    src = src.replace(
      helperAnchor,
      helperDef + "\n\n    " + helperAnchor,
    );
    results.helper = true;
  } else {
    msgs.push('getMsgKeyId helper anchor not found (may differ in this version)');
  }

  // ── Fix 1: 'Msg.get(newMsgKey._serialized)' should tolerate the $1 rename ──
  const fixReturn = src.replace(
    "Msg.get(newMsgKey._serialized);",
    "Msg.get(window.WWebJS.getMsgKeyId(newMsgKey));",
  );
  results.textReturn = fixReturn !== src;
  if (results.textReturn) src = fixReturn;
  else msgs.push('return-statement not found (may differ in this version)');

  // ── Fix 2: 'Msg.get(msg.id._serialized)' in editMessage (same rename) ──
  const fixEdit = src.replace(
    "Msg.get(msg.id._serialized);",
    "Msg.get(window.WWebJS.getMsgKeyId(msg.id));",
  );
  results.editReturn = fixEdit !== src;
  if (results.editReturn) src = fixEdit;

  // ── Fix 3: strip media `__x_id` sentinel that breaks Msg model init ──
  const fixMediaId = src.replace(
    "// Bot's won't reply if canonicalUrl is set (linking)\n        if (botOptions) {\n            delete message.canonicalUrl;\n        }\n\n        if (isChannel) {",
    (match) => {
      return (
        "// Bot's won't reply if canonicalUrl is set (linking)\n" +
        "        if (botOptions) {\n            delete message.canonicalUrl;\n        }\n\n" +
        "        // [" + MARKER + "] The MediaData model's `__x_id` (a `{sentinel}` object)\n" +
        "        // collides with the Msg model's id slot on this WA Web build, breaking\n" +
        "        // getSender during model init (media-send crash).\n" +
        "        if ('__x_id' in message && message.id && message.id !== message.__x_id) {\n" +
        "            delete message.__x_id;\n        }\n\n" +
        "        if (isChannel) {"
      );
    },
  );
  results.mediaId = fixMediaId !== src;
  if (results.mediaId) src = fixMediaId;
  else msgs.push('__x_id insertion point not found (may differ in this version)');

  const applied = results.textReturn || results.editReturn || results.mediaId || results.helper;
  if (applied) {
    writeFileSync(utilsPath, src, 'utf8');
    console.log(`🔧 [wa-patch] Patched whatsapp-web.js injected Utils.js (${JSON.stringify(results)})`);
  } else {
    console.log(`⚠️  [wa-patch] Nothing applied: ${msgs.join('; ')}`);
  }
  return { applied, results, messages: msgs };
}

// Auto-run on import (used by index.js before client init).
patchWawWebInjected();