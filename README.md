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
Every photo sent in the group is saved to `data/photos/<YYYY-MM-DD>/`.

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

All data is stored in SQLite database at `./data/sitebot.db`

## Tips for Site Use

1. **Daily Routine**: Update progress and diary at end of day
2. **Materials**: Log immediately when materials arrive
3. **Issues**: Report issues immediately with photos
4. **Reports**: Generate daily report before leaving site
5. **Attendance**: Record attendance at start of day

## License

MIT
