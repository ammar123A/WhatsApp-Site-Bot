import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  restartOnAuthFail: false,
  authTimeoutMs: 120000,
  puppeteer: {
    headless: true, protocolTimeout: 90000, timeout: 60000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-accelerated-2d-canvas', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run']
  }
});
client.on('qr', () => { console.log('QR NEEDED'); process.exit(1); });
client.on('auth_failure', (m) => { console.log('AUTH FAIL', m); process.exit(1); });
client.on('ready', async () => {
  try {
    const page = client.pupPage;
    const r = await page.evaluate(() => {
      const out = {};
      const WF = window.require('WAWebWidFactory');
      out.factoryKeys = Object.keys(WF).filter(k => /wid/i.test(k));
      // list functions
      out.factoryFns = Object.keys(WF).filter(k => typeof WF[k] === 'function').slice(0, 30);
      try {
        const w = WF.createWid('120363412164633402@g.us');
        out.createWid_group = { type: typeof w, keys: Object.keys(w).slice(0, 20), serialized: w._serialized, toString: String(w) };
      } catch (e) { out.createWid_group_ERR = String(e && e.message || e); }
      try {
        const w = WF.createWid('441234567890@c.us');
        out.createWid_user = { type: typeof w, keys: Object.keys(w).slice(0, 20), serialized: w._serialized, toString: String(w) };
      } catch (e) { out.createWid_user_ERR = String(e && e.message || e); }
      try {
        const w = WF.createGroupWid?.('120363412164633402');
        out.createGroupWid = { type: typeof w, keys: w && Object.keys(w).slice(0, 20), serialized: w && w._serialized, toString: w && String(w) };
      } catch (e) { out.createGroupWid_ERR = String(e && e.message || e); }
      return out;
    });
    console.log(JSON.stringify(r, null, 2));
    await client.destroy();
    process.exit(0);
  } catch (e) { console.log('ERR', e); process.exit(3); }
});
client.initialize();