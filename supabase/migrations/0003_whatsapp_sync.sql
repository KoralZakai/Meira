-- LUMI AI — WhatsApp task sync
-- 1. app_settings."whatsAppPhone": the app already mirrors AppSettings (which
--    includes whatsAppPhone) via upsertSettings — the column was missing, so
--    the mirror silently failed for users with a linked phone. Adding it both
--    fixes that and gives the WhatsApp server its phone -> userId lookup.
-- 2. tasks.source check: allow 'whatsapp' (WhatsAppTaskSync + the server both
--    write source='whatsapp'; the old CHECK rejected those rows silently).

alter table public.app_settings add column if not exists "whatsAppPhone" text;
create index if not exists app_settings_whatsapp_idx on public.app_settings ("whatsAppPhone");

alter table public.tasks drop constraint if exists tasks_source_check;
alter table public.tasks add constraint tasks_source_check
  check ("source" in ('voice','manual','suggested','email','calendar','whatsapp'));
