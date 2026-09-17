-- LUMI AI — user_profiles."routinesNotes" / "hobbies"
--
-- Onboarding has asked for these from the first version: hobbies, and
-- "constraints / habits: anything true about their days that a calendar will
-- never show — a school pickup, a standing class, an hour that is never free".
-- Both were saved into the local profile and neither had a column here, so a
-- reinstall lost the two facts that make an otherwise valid plan wrong.
--
-- They are now read for real: utils/routines turns them into habits to offer in
-- a free window ("your Monday gym, usually 18:00") and obligations to cut OUT of
-- it (the 16:00 school run is not free time), and the WhatsApp agent gets the
-- same text through save_profile(routines_notes=…).
--
-- The client tolerates the columns being absent (upsertTolerant drops unknown
-- ones and retries), so this migration is what makes them survive a reinstall
-- and reach the other device — not what makes the feature work.

alter table public.user_profiles
  add column if not exists "routinesNotes" text,
  add column if not exists "hobbies" text;
