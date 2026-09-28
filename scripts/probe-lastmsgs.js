import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  restartOnAuthFail: false,
  authTimeoutMs: 120000,
  puppeteer: { headless: true, protocolTimeout: 90000, timeout: 60000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-accelerated-2d-canvas', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run'] }
});
client.on('qr', () => { console.log('QR NEEDED'); process.exit(1); });
client.on('auth_failure', (m) => { console.log('AUTH FAIL', m); process.exit(1); });
client.on('ready', async () => {
  try {
    const data = await client.pupPage.evaluate(async (chatId) => {
      const out = { chatFound: false, msgs: [] };
      try {
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
        out.chatFound = !!(chat && chat.msgs);
        if (chat) {
          const models = chat.msgs && chat.msgs.models ? chat.msgs.models : [];
          const recent = models.slice(-12);
          for (const m of recent) {
            let type = '?', hasMedia = false, body = '', id = '';
            try { type = m.type || m.__x_type || ''; } catch (e) {}
            try { hasMedia = !!m.media; } catch (e) {}
            try { body = String(m.body || '') ; } catch (e) {}
            try { id = String(m.id && (m.id._serialized || m.id.$1 || m.id)); } catch (e) {}
            out.msgs.push({ type, hasMedia, body: body.slice(0, 40), id: id.slice(0, 50) });
          }
        }
      } catch (e) { out.err = String(e && e.message || e).slice(0, 200); }
      return out;
    }, '120363412164633402@g.us');
    console.log(JSON.stringify(data, null, 2));
    await client.destroy();
    process.exit(0);
  } catch (e) { console.log('FATAL', e); process.exit(3); }
});
client.initialize();