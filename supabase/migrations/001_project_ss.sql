-- Project SS report (replaces the plain diary view).
-- Additive only - existing diary rows keep working, new columns default NULL
-- and the bot asks the site team to fill them in.
--
--   Machinery & Equipment  -> consumables/tools, counted ("Grinder (small) - 1 nos")
--   Machinery             -> plant/machines, optional condition ("Backpusher (Repair)")
--   Attendance shift      -> "0800-1900" shown next to each worker in the report

alter table diary add column if not exists site_name text;
alter table diary add column if not exists machinery_equipment text;
alter table diary add column if not exists machinery text;
-- Operators are typed into .addss ("Operator: Reza (ex08)"), NOT taken from
-- attendance, so the section can legitimately be left empty for a day.
alter table diary add column if not exists operators text;

alter table attendance add column if not exists shift text;

-- Work orders need an editable description/category/priority + deletion is
-- already supported; milestones already have an update().