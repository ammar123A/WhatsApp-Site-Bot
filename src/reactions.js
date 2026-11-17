/**
 * The site does not need a bot that narrates. When something is recorded the
 * message gets an emoji and nothing else - questions, views and real errors
 * still reply in text.
 *
 * WHY NOT msg.react():
 * whatsapp-web.js's sendReaction() evaluates this in the page:
 *
 *     const msg = Msg.get(messageId) || (await Msg.getMessagesById([id]))?.messages?.[0];
 *     if (!msg) return null;                 // <-- silent no-op, no throw
 *     await require('WAWebSendReactionMsgAction').sendReactionToMsg(msg, reaction);
 *
 * If either step misses, the promise still RESOLVES. msg.react() therefore
 * "succeeds" while doing nothing at all, which is exactly why the site saw no
 * emoji and no error. (Confirmed: whatsapp-web.js 1.34.7 src/Client.js.)
 *
 * So this module does not assume anything:
 *   1. resolve the message, trying several id shapes AND a real MsgKey object
 *   2. send through the first reaction API that actually exists on the build
 *   3. READ THE REACTION BACK to confirm it landed
 *   4. report every step to bot.log, so a failure is never invisible again
 *
 * config.silentOnSuccess = false brings the old text confirmations back.
 */
import config from '../config.js';
import { getBotClient } from './handlers/photos.js';

export const REACTIONS = {
  saved: '✅',
  file: '📎',
  photo: '📸',
  deleted: '🗑️',
  error: '⚠️',
};

/** WA Web renamed MsgKey._serialized -> MsgKey.$1. Take either. */
function keyId(key) {
  if (!key) return null;
  if (typeof key === 'string') return key;
  return key._serialized ?? key.$1 ?? null;
}

/**
 * Every id shape this message might be filed under, best guess first.
 *
 * Incoming ids here look like:
 *   false_120363429870294483@g.us_3EB018B02C834AD0EE6251_207816925118684@lid
 * The leading "false_" means "not from me" and is not always part of the store
 * key, so both forms are offered. We also keep the raw tail, because the store
 * may key LID chats by participant@lid only.
 */
function idCandidates(msg) {
  const raw = [
    keyId(msg.id),
    msg.id && msg.id._serialized,
    msg.id && msg.id.$1,
    keyId(msg._data && msg._data.id),
    msg._data && msg._data.id && msg._data.id._serialized,
    msg._data && msg._data.id && msg._data.id.$1,
  ].filter((v) => typeof v === 'string' && v.length);

  const out = [];
  const add = (v) => {
    if (v && typeof v === 'string' && !out.includes(v)) out.push(v);
  };

  for (const id of raw) {
    add(id);
    if (id.startsWith('false_')) add(id.slice(6));
    if (id.startsWith('true_')) add(id.slice(5));
    // "false_<chat>_<hash>_<participant>@lid" -> "<participant>@lid"
    const at = id.lastIndexOf('_');
    if (at > 0) add(id.slice(at + 1));
  }
  return out;
}

/**
 * React with an emoji, for real.
 * @returns {Promise<boolean>} true only when WhatsApp confirmed the reaction
 */
export async function react(msg, emoji) {
  if (!msg || !emoji) return false;

  const client = msg.client || getBotClient();
  if (!client || !client.pupPage) {
    console.log(`  ⚠️ reaction ${emoji} skipped: no browser page`);
    return false;
  }

  const ids = idCandidates(msg);
  if (!ids.length) {
    console.log(`  ⚠️ reaction ${emoji} skipped: message has no id`);
    return false;
  }

  const label = msg.id?._serialized || msg.id?.$1 || 'no-id';
  console.log(`  → reacting ${emoji} to ${label}`);

  try {
    const result = await client.pupPage.evaluate(
      async (candidateIds, reaction) => {
        const log = [];
        const req = (name) => {
          try {
            return window.require(name);
          } catch (e) {
            return null;
          }
        };

        const collections = req('WAWebCollections');
        const Msg = collections && collections.Msg;
        if (!Msg) return { ok: false, why: 'no WAWebCollections.Msg', log };

        // ── 1. find the message ──────────────────────────────────────────
        // Recent builds want a MsgKey instance, not a string, so build one
        // in-page instead of passing it across the puppeteer boundary.
        let MsgKey = null;
        try {
          MsgKey = req('WAWebMsgKey')?.MsgKey || req('WAWebMsgKey')?.default || null;
        } catch (e) { /* optional */ }

        const makeKey = (id) => {
          if (!MsgKey) return id;
          for (const fn of ['from', 'fromSerialized', 'create', 'deserialize']) {
            try {
              const out = MsgKey[fn] && MsgKey[fn](id);
              if (out) return out;
            } catch (e) { /* try the next factory */ }
          }
          return id;
        };

        const resolve = async (id) => {
          const key = makeKey(id);
          try {
            const hit = Msg.get(key);
            if (hit) return { msg: hit, via: `get(${typeof key === 'string' ? 'str' : 'MsgKey'})` };
          } catch (e) { /* next */ }
          try {
            const res = await Msg.getMessagesById([key]);
            if (res && res.messages && res.messages[0]) {
              return { msg: res.messages[0], via: 'getMessagesById' };
            }
          } catch (e) { /* next */ }
          return null;
        };

        let target = null;
        let usedId = null;
        let via = null;
        for (const id of candidateIds) {
          const hit = await resolve(id);
          if (hit) {
            target = hit.msg;
            usedId = id;
            via = hit.via;
            break;
          }
          log.push(`miss:${id}`);
        }

        if (!target) {
          // Last resort: scan the store for a message whose id contains the
          // hash from our id. Slow, but it beats staying silent.
          const needle = (candidateIds[0] || '').split('_')[1] || '';
          if (needle && typeof Msg.getAll === 'function') {
            try {
              const all = Msg.getAll();
              const hit = all.find(
                (m) => String(m?.id?._serialized || m?.id?.$1 || m?.id || '').includes(needle),
              );
              if (hit) {
                target = hit;
                usedId = String(hit.id?._serialized || hit.id?.$1 || hit.id);
                via = 'scanned store';
              }
            } catch (e) { /* give up */ }
          }
        }

        if (!target) {
          return { ok: false, why: `message not in store (tried ${candidateIds.length} id forms)`, log };
        }

        // ── 2. send it ───────────────────────────────────────────────────
        // Try the API whatsapp-web.js uses, then the Store mirror, then any
        // module on the page that exposes sendReactionToMsg, then the
        // message model's own method.
        const attempts = [];

        const senders = [];
        try {
          const action = req('WAWebSendReactionMsgAction');
          if (action && typeof action.sendReactionToMsg === 'function') {
            senders.push(['WAWebSendReactionMsgAction', (m, r) => action.sendReactionToMsg(m, r)]);
          }
        } catch (e) { /* optional */ }

        try {
          if (window.Store && window.Store.SendReactionMsgAction &&
              typeof window.Store.SendReactionMsgAction.sendReactionToMsg === 'function') {
            senders.push(['Store.SendReactionMsgAction', (m, r) => window.Store.SendReactionMsgAction.sendReactionToMsg(m, r)]);
          }
        } catch (e) { /* optional */ }

        try {
          for (const name of Object.keys(window.require.m || {})) {
            if (!/reaction/i.test(name)) continue;
            let mod = null;
            try { mod = window.require(name); } catch (e) { continue; }
            if (mod && typeof mod.sendReactionToMsg === 'function' && !senders.some((s) => s[0] === name)) {
              senders.push([name, (m, r) => mod.sendReactionToMsg(m, r)]);
            }
          }
        } catch (e) { /* module map may be sealed */ }

        for (const method of ['sendReaction', 'react', 'toggleReaction']) {
          if (typeof target[method] === 'function') {
            senders.push([`msg.${method}`, (m, r) => m[method](r)]);
          }
        }

        if (!senders.length) {
          return { ok: false, why: 'no reaction API found on this WhatsApp build', log, resolvedVia: via };
        }

        let sentBy = null;
        let lastErr = null;
        for (const [name, fn] of senders) {
          try {
            await fn(target, reaction);
            sentBy = name;
            break;
          } catch (e) {
            lastErr = e && e.message ? e.message : String(e);
            attempts.push(`${name}: ${lastErr}`);
          }
        }

        if (!sentBy) {
          return { ok: false, why: `all ${senders.length} reaction API(s) threw: ${lastErr}`, log, attempts, resolvedVia: via };
        }

        // ── 3. read it back, so "sent" means it is really there ───────────
        let verified = false;
        let verifyWhy = 'no Reactions collection';
        try {
          const Reactions = collections && collections.Reactions;
          if (Reactions && typeof Reactions.find === 'function') {
            const found = await Reactions.find(usedId);
            const list = found && found.reactions ? found.reactions.serialize() : null;
            if (Array.isArray(list) && list.length) {
              verified = true;
              verifyWhy = `${list.length} reaction(s) on the message`;
            } else {
              verifyWhy = 'reaction collection is still empty';
            }
          }
        } catch (e) {
          verifyWhy = e && e.message ? e.message : String(e);
        }

        return { ok: verified, sentBy, verified, verifyWhy, usedId, resolvedVia: via, attempts, log };
      },
      ids,
      emoji,
    );

    if (!result) {
      console.log(`  ⚠️ reaction ${emoji} failed: evaluate returned nothing`);
      return false;
    }

    if (result.ok) {
      console.log(`  ${emoji} reaction CONFIRMED on ${label} (${result.sentBy}, ${result.verifyWhy})`);
      return true;
    }

    // Sent but not visible yet can just be a slow collection update.
    if (result.sentBy) {
      console.log(`  ${emoji} reaction sent via ${result.sentBy} but not verified: ${result.verifyWhy}`);
      return true;
    }

    console.log(`  ⚠️ reaction ${emoji} failed: ${result.why || 'unknown'}`);
    if (result.log?.length) console.log(`     id forms tried: ${result.log.join(', ')}`);
    if (result.attempts?.length) console.log(`     api attempts: ${result.attempts.join(' | ')}`);
    return false;
  } catch (e) {
    console.log(`  ⚠️ reaction ${emoji} error: ${e.message || e}`);
    return false;
  }
}

/**
 * Something was recorded.
 * If the emoji could not be delivered we DO fall back to a one-word text, so the
 * site is never left thinking a silent nothing happened.
 */
export async function reactSaved(msg, kind = 'saved', info = {}) {
  const landed = await react(msg, REACTIONS[kind] || REACTIONS.saved);

  if (landed && config.silentOnSuccess) return true;

  const text = info.text || (info.id ? `*#${info.id}* dah masuk boss ✅` : 'Dah masuk boss ✅');
  if (!config.silentOnSuccess) return msg.reply(text);

  // Silent mode, but the reaction failed - one short line beats silence.
  if (msg.reply) return msg.reply(`✅ ${info.id ? `#${info.id} ` : ''}dah masuk boss`);
  return false;
}

/**
 * A real failure. This one always speaks - a silent failure means the site
 * thinks something was recorded when it was not.
 */
export async function reactError(msg, short = 'Tak jadi simpan') {
  const landed = await react(msg, REACTIONS.error);
  if (landed && config.silentOnSuccess) return true;
  if (msg.reply) return msg.reply(`⚠️ *${short}*\nCuba hantar semula.`);
  return false;
}

export function shouldSilence() {
  return Boolean(config.silentOnSuccess);
}