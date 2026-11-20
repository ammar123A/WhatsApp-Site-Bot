/**
 * Monthly claim scheduler.
 *
 * On the 28th, every month that has receipts but no compiled sheet gets one:
 * the receipts are turned into a single PDF, sent back to the person who
 * forwarded them, and the month's total is stated.
 *
 * Two things this deliberately gets right:
 *
 *  1. It runs from the RECORD, not from the clock. "Day >= 28 AND this month has
 *     no sheet yet" means a bot that was off on the 28th still sends the claim
 *     on the 29th, and a restart on the 28th cannot send it twice.
 *  2. Older uncompiled months are picked up too, but one month per tick, so a
 *     bot left off for months does not fire a burst of PDFs at once.
 */
import { personalClaimsDB, ensurePersonalSchema, claimMonth } from './database.js';
import { sendMonthlyClaim, CLAIM_DAY, money } from './handlers/claims.js';

const CHECK_EVERY_MIN = 30;
let timer = null;

/**
 * @returns {{sent: object[], skipped: number, reason?: string}}
 */
export async function runClaimSweep(client, { now = new Date(), force = false, jid = null } = {}) {
  await ensurePersonalSchema();

  // `jid` limits a manual run to one person's claims.
  const pending = (await personalClaimsDB.uncompiledMonths()).filter((r) => !jid || r.jid === jid);
  if (!pending.length) return { sent: [], skipped: 0, reason: 'nothing pending' };

  const thisMonth = claimMonth(now);
  const day = now.getDate();
  const monthOpen = day >= CLAIM_DAY;

  // Before the 28th, only an explicit test run compiles anything.
  if (!force && !monthOpen) {
    return { sent: [], skipped: pending.length, reason: `before the ${CLAIM_DAY}th` };
  }

  const sent = [];
  let skipped = 0;
  let backlogDone = 0;

  for (const row of pending) {
    const isCurrent = row.month === thisMonth;

    // A forced run (a test, or a manual trigger) clears everything. Otherwise
    // only the current month goes out on the 28th, plus ONE backlog month per
    // sweep so a bot that was off for months still catches up without turning
    // into a wall of PDFs on the 28th.
    if (!force) {
      if (!monthOpen) { skipped++; continue; }
      if (!isCurrent) {
        if (backlogDone >= 1) { skipped++; continue; }
        backlogDone++;
      }
    }

    try {
      const out = await sendMonthlyClaim(client, row.jid, row.month, { date: now });
      if (out.ok) sent.push(out);
      else skipped++;
    } catch (e) {
      console.error(`[claim] sweep failed for ${row.jid} ${row.month}:`, e.message || e);
      skipped++;
    }
  }

  return { sent, skipped };
}

/** Start the daily-ish check. Safe to call once at startup. */
export function startClaimScheduler(client) {
  if (timer) return timer;
  const tick = async () => {
    try {
      const out = await runClaimSweep(client);
      if (out.sent.length) {
        for (const s of out.sent) {
          console.log(`[claim] compiled ${s.count} receipts for ${s.month}, total RM ${money(s.total)}`);
        }
      } else if (out.reason) {
        console.log(`[claim] sweep: nothing to do (${out.reason}${out.skipped ? `, ${out.skipped} month(s) waiting` : ''})`);
      }
    } catch (e) {
      console.error('[claim] scheduler error:', e.message || e);
    }
  };

  // First check a few seconds after boot so the claim tables exist before the
  // first real message arrives, then on the interval.
  setTimeout(tick, 5000).unref?.();
  timer = setInterval(tick, CHECK_EVERY_MIN * 60 * 1000);
  timer.unref?.();
  console.log(`[claim] scheduler on: claim sheet on the ${CLAIM_DAY}th, checking every ${CHECK_EVERY_MIN} min`);
  return timer;
}

export function stopClaimScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { CLAIM_DAY };