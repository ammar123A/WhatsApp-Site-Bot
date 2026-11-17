/** Repair progress/material/issue photo columns after site-bucket migration. */
import * as db from '../src/database.js';

const sites = [
  { siteName: 'Myself Group', groupId: '120363429870294483@g.us' },
  { siteName: 'AE WORKS', groupId: '120363422956016150@g.us' },
  { siteName: 'SiteMate', groupId: '120363412164633402@g.us' },
];

const tables = { progress: db.progressDB, material: db.materialsDB, issue: db.issuesDB };
const base = (p) => String(p || '').split('/').pop();

for (const siteInfo of sites) {
  const site = await db.ensureSiteSchema(siteInfo);
  await db.runInSite(site, async () => {
    const files = await db.filesDB.getRecent(10000);
    for (const file of files) {
      const table = tables[file.link_type];
      if (!table || !file.link_id || file.category !== 'photos') continue;
      const entry = await table.getById(file.link_id);
      if (!entry || !table.updatePhotos) continue;

      let current = [];
      try { current = entry.photos ? JSON.parse(entry.photos) : (entry.photo ? [entry.photo] : []); } catch {}
      const ref = `${file.bucket}::${file.path}`;
      const wantedName = base(file.path);
      const next = current.length
        ? current.map((p) => base(p) === wantedName || !String(p).includes('::') ? ref : p)
        : [ref];
      const unique = [...new Set(next)];
      if (JSON.stringify(unique) !== JSON.stringify(current)) {
        await table.updatePhotos(file.link_id, unique);
        console.log(`${siteInfo.siteName}: ${file.link_type} #${file.link_id} -> ${ref}`);
      }
    }
  });
}
