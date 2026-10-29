-- 0014 — sealed personal fields on the app's own rows (7.10 security audit)
--
-- tasks and user_profiles carried what she will do, where, with whom, and her
-- home address in plaintext columns. Now the app and the server write those
-- fields as ONE AES-256-GCM blob in "sealed", under a key derived per account
-- (server/field_crypto.py, POST /app/data-key), and empty the plaintext
-- columns — tasks.text reads '🔒', user_profiles.name reads '🔒'.
--
-- Additive and inert: nothing writes "sealed" until SEAL_APP_ROWS=1 is set in
-- fly.toml. Order: run this → every tester on the app build that reads sealed
-- rows → set SEAL_APP_ROWS=1 and push. Safe to run twice.

alter table public.tasks         add column if not exists "sealed" text;
alter table public.user_profiles add column if not exists "sealed" text;

-- user_profiles.homeLat / homeLng are NOT NULL default 0; a sealed profile
-- writes 0 there, which the app already reads as "unknown".
