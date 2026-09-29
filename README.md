# 🏗️ WhatsApp Site Bot

WhatsApp bot for construction site management - track progress, materials, and issues in your group.

## Features

- **📝 Progress Tracking** - Log daily work progress by category
- **📦 Materials Management** - Track incoming materials, suppliers, stock levels
- **⚠️ Issue Tracking** - Report and track site issues with priorities
- **📒 Site Diary** - Weather, visitors, safety notes
- **👷 Attendance** - Worker attendance and overtime tracking
- **📋 Work Orders** - Create and assign tasks
- **🎯 Milestones** - Track project milestones
- **📊 Reports** - Daily and weekly site reports

## Setup

### 1. Install Dependencies

```bash
cd whatsapp-site-bot
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Edit `.env`:
```env
SITE_GROUP_NAME=Your Site Group Name
SITE_GROUP_INVITE=https://chat.whatsapp.com/XXXXXXXXXXXXXXXXXXXXXX
ADMIN_NUMBERS=60123456789,60198765432
```

The bot only responds inside this one group. `SITE_GROUP_INVITE` is preferred; `SITE_GROUP_NAME` is the fallback. Admin numbers use international format without `+`.

### 3. Run the Bot

```bash
npm start
```

Scan the QR code with WhatsApp to authenticate.

## Commands

### Progress
| Command | Description |
|---------|-------------|
| `.progress` | Today's progress |
| `.progress week` | This week's progress |
| `.progress month` | This month's progress |
| `.addprogress` | Add progress entry |

**Add Progress Format:**
```
.addprogress
Category: Civil
Description: Foundation work done
Percentage: 50
Location: Block A
By: Contractor A
```

### Materials
| Command | Description |
|---------|-------------|
| `.materials` | Today's materials |
| `.stock` | Current stock summary |
| `.addmaterial` | Add material entry |

**Add Material Format:**
```
.addmaterial
Name: Cement
Category: Cement
Quantity: 100
Unit: bags
Supplier: ABC Corp
PO: PO-001
Location: Store
By: John
```

### Issues
| Command | Description |
|---------|-------------|
| `.issues` | Open issues |
| `.issues all` | All issues |
| `.issuestats` | Issue statistics |
| `.addissue` | Report issue |
| `.resolve [id] [desc]` | Mark resolved |
| `.assign [id] [name]` | Assign issue |

**Add Issue Format:**
```
.addissue
Title: Water leak
Description: Leak at 2nd floor
Category: MEP
Priority: high
Location: Block A L2
By: Site Engineer
```

### Photos
Every photo sent in the group is saved to the `site-photos` bucket (one folder per day). The bot reacts 📸 to confirm; use `.photo` to see the saved path.

| Command | Description |
|---------|-------------|
| `.attach [progress\|material\|issue] [id]` | Link recently sent photo(s) to a record |
| `.photo` | Show where the latest photo was saved |

Tip: send the photo with `.addissue` / `.addprogress` / `.addmaterial` as the caption to attach it directly.

### Diary
| Command | Description |
|---------|-------------|
| `.diary` | Today's diary |
| `.adddiary` | Update diary |

**Add Diary Format:**
```
.adddiary
Weather: Sunny
Temp: 32C
Visitors: Client PM
Notes: Work progressing well
Safety: All PPE in use
```

### Attendance
| Command | Description |
|---------|-------------|
| `.attendance` | Today's attendance |
| `.attendance summary [name]` | Worker summary |
| `.addattendance` | Add attendance |

**Add Attendance Format:**
```
.addattendance
Name: Ali
Contractor: ABC
Role: Foreman
Hours: 9
OT: 2
```

### Work Orders
| Command | Description |
|---------|-------------|
| `.workorders` | Pending work orders |
| `.addworkorder` | Create work order |

### Milestones
| Command | Description |
|---------|-------------|
| `.milestones` | List milestones |
| `.addmilestone` | Add milestone |

### Reports
| Command | Description |
|---------|-------------|
| `.dailyreport` | Full daily report |
| `.weeklyreport` | Weekly summary |

## Categories

### Progress Categories
Civil, Structural, MEP, Architecture, Interior, External, Safety, Others

### Material Categories
Concrete, Steel, Timber, Bricks, Sand, Aggregate, Cement, Pipes, Electrical, Plumbing, Finishing, Others

### Issue Priority
- 🔴 **Urgent** - Immediate attention required
- 🟠 **High** - Important, resolve quickly
- 🟡 **Medium** - Normal priority
- 🟢 **Low** - Can wait

## Data Storage

Records are stored in Supabase Postgres, and photos in the private Supabase Storage bucket `site-photos` (one folder per day).

One-time setup:
1. Create a project at [supabase.com](https://supabase.com) (region: Singapore).
2. SQL Editor → paste [supabase/schema.sql](supabase/schema.sql) → Run.
3. Storage → New bucket → name `site-photos`, leave **Public** off.
4. Fill `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and `DATABASE_URL` in `.env` (see `.env.example`).
5. Moving from the old local SQLite version? Run `node scripts/migrate-to-supabase.js` once.

## Tips for Site Use

1. **Daily Routine**: Update progress and diary at end of day
2. **Materials**: Log immediately when materials arrive
3. **Issues**: Report issues immediately with photos
4. **Reports**: Generate daily report before leaving site
5. **Attendance**: Record attendance at start of day

## Keeping the Bot's Number Safe

This bot uses whatsapp-web.js, an unofficial client. That is against WhatsApp's Terms, and WhatsApp can ban the linked number without warning. To keep the risk low:

- **Use a dedicated SIM**, never a personal or important number. Warm it up with normal human use for 1–2 weeks before linking the bot. Turn on two-step verification, and ask group members to save it as a contact.
- **Keep the phone online.** A linked device drops if the phone is offline for about 14 days.
- **Don't re-link needlessly.** `run.bat` keeps the session across restarts and wipes it only when WhatsApp revoked it (exit code 2). Don't delete `.wwebjs_auth` by hand unless you have to.
- **Reply only, never broadcast.** No scheduled, outbound or bulk messages, and no DMs to people who didn't message first. Outgoing messages are already spaced 1–2.5s apart.
- **If sends start failing, stop and investigate.** Don't retry harder, because failing sends may mean WhatsApp is flagging the session.
- **Never run `scripts/test-*.js` against the production number.**
- **Update whatsapp-web.js only on purpose.** Afterwards, check that `scripts/wa-patch.js` still logs that it applied, because it patches exact strings from v1.34.7.
- **Tell the group.** Pin a message saying the bot stores photos and site records in Supabase. This is the PDPA notice.

## License

MIT
