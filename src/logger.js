/**
 * Mirror everything the bot prints into bot.log.
 *
 * The bot normally runs in a window the user is watching, which is good for them
 * and useless for debugging: when a reaction silently fails there is no record of
 * what the terminal said. Piping through Tee-Object does not work either -
 * PowerShell buffers native output - so the bot writes its own log.
 *
 * Imported for its side effect, before anything else:
 *
 *   import './src/logger.js';
 *
 * Set BOT_LOG=off to disable it.
 */
import { appendFileSync } from 'fs';

const LOG_FILE = 'bot.log';

if (process.env.BOT_LOG !== 'off') {
  const stamp = () => new Date().toLocaleTimeString();

  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        const text = args
          .map((a) => (typeof a === 'string' ? a : safeJson(a)))
          .join(' ')
          .replace(/\s+$/, '');
        appendFileSync(LOG_FILE, `[${stamp()}] ${text}\n`);
      } catch {
        // Never let logging take the bot down.
      }
      original(...args);
    };
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}