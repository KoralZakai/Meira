-- LUMI AI — app_settings."wakeAlarmEnabled"
--
-- The alarm toggle added `wakeAlarmEnabled` to AppSettings, and DEFAULT_SETTINGS
-- sets it on every install. upsertSettings mirrors the WHOLE settings object, so
-- from that moment every settings write was rejected by PostgREST with
--
--     Could not find the 'wakeAlarmEnabled' column of 'app_settings'
--     in the schema cache
--
-- and a rejected settings write takes `whatsAppPhone` down with it — which is
-- the column the WhatsApp server uses to resolve phone -> userId. So a UI
-- toggle silently broke WhatsApp sync: tasks kept arriving in the chat and none
-- of them could ever reach the app. Exactly the failure 0003 fixed for
-- whatsAppPhone itself.
--
-- The client no longer depends on this landing first (upsertSettings now drops
-- unknown columns and retries), but the column is what makes the setting sync
-- across devices instead of staying local.

alter table public.app_settings
  add column if not exists "wakeAlarmEnabled" boolean not null default true;
