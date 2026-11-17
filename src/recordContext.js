/**
 * Reads what is actually in the site DB so the LLM can be told the truth.
 *
 * The AI used to answer "takde gambar baru" because it only ever saw recent CHAT
 * TEXT. Photos live in the DB (site_files), so a question like "boleh bagi gambar
 * progress?" had no basis in anything the model was shown. This module builds a
 * compact factual snapshot of the current site's recent records + whether each has
 * a photo attached, and the prompt tells the model that when they ask to see
 * pictures it MUST use action "view" (which goes through replyListWithPhotos and
 * sends one image per message) instead of guessing.
 *
 * Read-only, and deliberately tiny - this goes into a prompt on every tagged
 * message, so it stays short and bounded.
 */
import {
  progressDB,
  materialsDB,
  issuesDB,
  attendanceDB,
  diaryDB,
  pendingDB,
  chatLogDB,
  runInSite,
} from './database.js';
import { getRecordPhotos } from './utils.js';

// The SS row is keyed by the same DD/MM/YYYY string used everywhere else in this
// schema (see getToday()). Built locally to avoid a circular import with utils.
function todayDate() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return Promise.resolve(`${day}/${month}/${now.getFullYear()}`);
}

const RECENT = 5;
const MAX_DESC = 90;

// Keep it factual and short. Every field here is either a real DB value or a
// boolean "has photo(s)" - never a model's opinion.
function clip(v, n = MAX_DESC) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function line(label, rows, format) {
  if (!rows.length) return `${label}: (none recorded)`;
  return `${label}:\n${rows.map(format).join('\n')}`;
}

/** Filler and conversational noise - never useful as a search keyword. */
const STOPWORDS = new Set([
  'yang', 'untuk', 'dengan', 'dari', 'pada', 'itu', 'ini', 'tu', 'nak', 'dah',
  'ada', 'bagi', 'boleh', 'tolong', 'masa', 'hari', 'site', 'boss', 'tq',
  'the', 'and', 'for', 'was', 'with', 'that', 'this', 'from', 'have', 'has',
]);

/** Content words worth searching on, longest first so "bumbung" wins. */
export function keywords(text, limit = 5) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    // Drop unit-internal digits so "m3" does not become the keyword "3".
    .filter((w) => !/^\d+$/.test(w) || w.length > 2)
    .slice(0, limit);
}

/**
 * Find records that MATCH what they asked about, not just the last five.
 *
 * The bot could only see recent records, so "pasti issue paip" or "cari
 * progress blok A" found nothing even when the record was right there. This
 * searches description/title/location/reporter across every table.
 *
 * Read-only. Returns a prompt block; when nothing matches it says so plainly
 * rather than leaving the model to guess.
 *
 * @param {{schema:string, siteName:string}} site
 * @param {string} text the user's own words
 */
export async function recallRecords(site, text) {
  const words = keywords(text);
  if (!site || !site.schema || !words.length) return '';

  return runInSite(site, async () => {
    const out = [];

    const search = async (label, db, fields, render) => {
      // Try each keyword, longest first, so the most specific one wins.
      for (const word of words) {
        const hits = await db.searchFields(fields, word, 4).catch(() => []);
        if (!hits.length) continue;
        out.push(`${label} matching "${word}":\n${hits.map(render).join('\n')}`);
        return;
      }
    };

    await search('MATCHING PROGRESS', progressDB, ['description', 'location', 'reported_by'], (r) => {
      const pics = getRecordPhotos(r).length;
      return `  - #${r.id} ${r.date} "${clip(r.description)}"${r.location ? ` @ ${clip(r.location, 40)}` : ''}${pics ? ` [${pics} photo(s)]` : ''}`;
    });
    await search('MATCHING ISSUE', issuesDB, ['title', 'description', 'location', 'reported_by'], (r) => {
      const pics = getRecordPhotos(r).length;
      return `  - #${r.id} ${r.date} "${clip(r.title || r.description)}" (${r.status || '?'}${r.priority ? `, ${r.priority}` : ''})${pics ? ` [${pics} photo(s)]` : ''}`;
    });
    await search('MATCHING MATERIAL', materialsDB, ['material_name', 'supplier', 'location', 'received_by', 'po_number'], (r) =>
      `  - #${r.id} ${r.date} "${clip(r.material_name)}" qty ${r.quantity ?? '?'}${r.unit ? ' ' + r.unit : ''}`
    );
    await search('MATCHING PENDING ITEM', pendingDB, ['task', 'pic', 'location', 'notes'], (r) =>
      `  - #${r.id} "${clip(r.task)}" (${r.status}${r.pic ? `, PIC ${clip(r.pic, 30)}` : ''})`
    );

    // Chat history, so " Maco kata paip tu apa jadi?" can be answered from what
    // people actually said rather than invented. Only real messages, never the
    // bot's own replies, which would just echo the model's guesses back at it.
    for (const word of words) {
      const hits = await chatLogDB.search(word, 6).catch(() => []);
      const said = hits.filter((h) => !h.is_bot && h.body);
      if (!said.length) continue;
      out.push(
        `SAID IN THE GROUP CHAT matching "${word}":\n${said
          .map((h) => `  - ${h.date} ${clip(h.sender, 20)}: "${clip(h.body, 120)}"`)
          .join('\n')}`
      );
      break;
    }

    return out.length
      ? `\n\nRECORDS MATCHING WHAT THEY ASKED (searched every record, not just recent):\n${out.join('\n')}`
      : `\n\nNO RECORD MATCHES the words: ${words.map((w) => `"${w}"`).join(', ')}. If they are asking whether something was recorded, say you found no match - do not guess.`;
  });
}

/**
 * Snapshot of recent records for ONE site.
 *
 * The site is passed in and used explicitly. Without a scope the query layer falls
 * back to the shared `public` tables - so an unscoped call silently returned
 * another group's data (or the legacy shared data), which is exactly the leak the
 * per-site schemas exist to prevent.
 *
 * @param {{schema:string, siteName:string}} site
 * @returns {Promise<string>} plain text block for the prompt
 */
export async function buildRecordSnapshot(site) {
  if (!site || !site.schema) throw new Error('buildRecordSnapshot needs a site scope');
  return runInSite(site, async () => {
    const [progress, material, issue, attendance, ss] = await Promise.all([
      progressDB.getRecent(RECENT).catch(() => []),
      materialsDB.getRecent(RECENT).catch(() => []),
      issuesDB.getRecent(RECENT).catch(() => []),
      // attendance is a per-day list, so there is no "recent" - today or nothing.
      todayDate().then((d) => attendanceDB.getByDate(d)).catch(() => []),
      // Same DD/MM/YYYY shape getToday() produces - every other date column in this
      // schema uses it, and the SS row is keyed by it.
      todayDate().catch(() => null),
    ]);

  const parts = [
    line('RECENT PROGRESS (newest last)', progress, (r) => {
      const pics = getRecordPhotos(r).length;
      return `  - #${r.id} ${r.date} "${clip(r.description)}"${pics ? ` [${pics} photo(s)]` : ' [no photo]'}`;
    }),
    line('RECENT MATERIAL', material, (r) => {
      const pics = getRecordPhotos(r).length;
      return `  - #${r.id} ${r.date} "${clip(r.material_name || r.material)}" qty ${r.quantity ?? '?'}${r.unit ? ' ' + r.unit : ''}${pics ? ` [${pics} photo(s)]` : ''}`;
    }),
    line('RECENT ISSUE', issue, (r) => {
      const pics = getRecordPhotos(r).length;
      return `  - #${r.id} ${r.date} "${clip(r.title || r.description)}" (${r.status || '?'}${r.priority ? `, ${r.priority}` : ''})${pics ? ` [${pics} photo(s)]` : ''}`;
    }),
    line('TODAY ATTENDANCE', attendance, (r) => `  - ${clip(r.worker_name, 40)}${r.shift ? ` (${r.shift})` : ''}`),
  ];

  if (ss && typeof ss === 'object') {
      const filled = Object.entries(ss)
        .filter(([k, v]) => v && !/^id$|^date$/i.test(k) && typeof v === 'string')
        .map(([k, v]) => `${k.replace(/_/g, ' ')}=${clip(v, 40)}`)
        .slice(0, 5);
      parts.push(`TODAY SITE SS: ${filled.length ? filled.join('; ') : '(empty)'}`);
    }

    return parts.join('\n');
  });
}