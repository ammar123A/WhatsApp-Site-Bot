// Site identity derived from the WhatsApp group the bot is sitting in.
//
// Each site gets its own group, and the group name carries the site name:
//   "HY Sky Awani Prima"   -> site "Sky Awani Prima"
//   "Sky Awani Prima"      -> site "Sky Awani Prima"
//   "HYSD - KL Sentul"     -> site "KL Sentul"
// Every other site the bot is invited to is simply another site, so nothing
// here is hard-coded to one project.
//
// The DB split per site is done later (separate Supabase project per site).
// For now this gives every record a site label and groups the bot per room.

const PREFIXES = [
  'hysd', 'hy', 'hsd', 'sdb', 'sdi', 'lvl', 'project', 'projek', 'site', 'projeks',
];

// Group names that are about the bot itself, not a site.
const NON_SITE = /^(kerani|sitebot|site bot|sitemate|test|bot|testing|group|grup|admin|dev|debug)$/i;

function tidy(name) {
  return String(name || '')
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '') // zero-width / bidi marks
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Work out the site name from a group name.
 * @param {string} groupName e.g. "HY Sky Awani Prima"
 * @returns {string} e.g. "Sky Awani Prima"
 */
export function deriveSiteName(groupName) {
  let name = tidy(groupName);
  if (!name) return 'Unknown Site';

  if (NON_SITE.test(name)) return name;

  // Strip a leading token that is a known marker, e.g. "HY Sky Awani Prima".
  const words = name.split(' ');
  while (words.length > 1) {
    const first = words[0].toLowerCase().replace(/[^a-z]/g, '');
    if (PREFIXES.includes(first)) {
      words.shift();
      continue;
    }
    break;
  }
  name = words.join(' ').trim();

  // Group names are often "HY Sky Awani Prima - Group" / "..." - drop a
  // trailing generic tail after a dash.
  name = name.replace(/\s*[-–—|]\s*(group|grup|chat|official|team)$/i, '').trim();

  return name || 'Unknown Site';
}

const sites = new Map(); // groupId -> { groupId, name, site, seenAt }

/**
 * Only serve groups that are known site groups.
 *
 * The bot is in family chats and personal groups too. Answering "saya site
 * assistant" in those is noise, and worse, it can file site records into the
 * wrong room. So a group is served only when it is explicitly allowed:
 *   - SITE_GROUPS in .env (comma separated group ids or invite-code names), or
 *   - someone runs `.site` inside it, or
 *   - the admin tags the bot once to register it.
 * Everything else is muted. This is an allow-list on purpose: guessing from a
 * group name would either mute a real site or serve a personal chat.
 */
const allowed = new Set();
const blocked = new Set();

/** Mark a group as a site group the bot should serve. */
export function allowGroup(groupId) {
  blocked.delete(groupId);
  allowed.add(groupId);
  return groupId;
}

/** Mark a group as "not a site group" - bot goes silent there. */
export function blockGroup(groupId, why = 'manual') {
  blocked.add(groupId);
  allowed.delete(groupId);
  sites.delete(groupId);
  return { groupId, why };
}

/** Allow a group again. */
export function unblockGroup(groupId) {
  blocked.delete(groupId);
  allowed.add(groupId);
  return groupId;
}

/** True when the bot must ignore this group entirely. */
export function isBlockedGroup(groupId) {
  return blocked.has(groupId);
}

/**
 * May the bot post in this group? Allowed list wins; an explicitly blocked
 * group never serves, even if it was allowed before.
 */
export function isAllowedGroup(groupId) {
  return allowed.has(groupId) && !blocked.has(groupId);
}

/** Every group we serve, plus anything explicitly muted. */
export function listGroups() {
  return {
    allowed: [...allowed],
    blocked: [...blocked],
  };
}

/** Seed the allow-list from config (env var, comma separated). */
export function allowGroupsFromEnv(csv) {
  const ids = String(csv || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.includes('@') ? s : `${s}@g.us`));
  ids.forEach((id) => allowed.add(id));
  return ids;
}

/**
 * Remember a group we are active in and what site it represents.
 * @returns {{groupId:string,name:string,site:string}}
 */
export function registerGroup(groupId, groupName) {
  const site = deriveSiteName(groupName);
  const existing = sites.get(groupId);
  // Re-derive every scan: a renamed group must update its site name. Keeping
  // `existing.site` here meant a rename was silently ignored forever, so a group
  // called "AE WORKS - Block C" would keep answering as the old site.
  const entry = { groupId, name: tidy(groupName), site };
  sites.set(groupId, entry);
  return { ...entry, renamed: Boolean(existing) && existing.site !== site };
}

/** Every group we have seen, newest activity last. */
export function listSites() {
  return [...sites.values()];
}

/** Site name for a group, or null if we have not seen it yet. */
export function siteFor(groupId) {
  return sites.get(groupId)?.site || null;
}

/** Site name for a group (falls back to deriving from its name). */
export function getSiteName(groupId) {
  return sites.get(groupId)?.site || null;
}

/**
 * Completely forget a group we are no longer in: it must not stay in the site
 * registry, must not stay on the allow-list, and must not appear in any listing.
 * Used when the bot is removed from a group.
 */
export function forgetGroup(groupId) {
  const known = sites.get(groupId);
  sites.delete(groupId);
  allowed.delete(groupId);
  blocked.add(groupId);
  return known || null;
}

/**
 * Drop any remembered group that is not in the list we are actually in any more.
 *
 * WhatsApp does not always deliver a `group-leave` event when the bot is kicked,
 * so the periodic scan reconciles: anything we no longer see is gone for good and
 * must stop being served. Without this, a group the bot had been removed from
 * stayed on the allow-list and would resume recording the moment it was
 * re-added.
 *
 * @param {string[]} presentIds group ids from the current scan
 * @returns {string[]} ids that were forgotten
 */
export function forgetMissingGroups(presentIds) {
  const present = new Set(presentIds);
  const forgotten = [];
  for (const id of [...allowed, ...sites.keys()]) {
    if (!present.has(id)) forgotten.push(id);
  }
  forgotten.forEach((id) => forgetGroup(id));
  return forgotten;
}