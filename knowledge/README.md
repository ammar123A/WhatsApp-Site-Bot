# Company Knowledge

Drop plain notes in this folder. Everything here is folded into the bot's prompt,
so it learns about **your** company, projects, contracts and standing arrangements.

## How to use

- One file per topic, e.g. `company.md`, `clients.md`, `contracts.md`.
- `.md` or `.txt`. Keep it in plain language - the bot reads it as written.
- In WhatsApp, run **`.knowledge`** to check what is loaded and where the folder is.
- No restart needed: `.knowledge` reloads from disk.

## What to write here

Things the bot genuinely cannot guess: who you are, who the client is, contract
numbers, project names, team names and roles, suppliers, standing arrangements,
site rules, and the words your crew actually uses for things.

## What NOT to write here

- **Nothing sensitive.** This text is sent to the Gemini API on every tagged
  message. No bank details, no personal ID numbers, no passwords, no confidential
  client pricing you would not paste into a chat.
- **Not a record.** Knowledge notes never create progress / material / issue /
  attendance rows. If you want a record, say it in the group normally.
- No quantities, prices or dates you want the bot to file for you. The bot will
  not fill a record in from this file - it uses it for answering questions only.

## Example: company.md

```markdown
# Company
Name: Bina Murni Sdn Bhd
Main work: civil & structural, Klang Valley
Client side: JKR via consultant Arkitek Kumpulan

# Who is who
- Azman - mandur, block A
- Rafi - plant operator, excavator E13
- Supervisor: Puan Sarah
- PM: Encik Lim

# Standing arrangements
- Toolbox talk every Monday 7am
- Material deliveries must be checked against the DO before signing
- Concrete pours need a cube test within 24h
```

## Priority order

If a note here disagrees with what someone says in the group right now, the
**live message wins** and the bot points out the difference.