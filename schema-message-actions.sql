-- Hearth Chat: message actions (reactions, replies, edited flag)
-- Run this once in the Supabase SQL editor to enable cross-device sync of the
-- new message tools. The app still works without it: sending, edited text and
-- deletes/clears use existing columns; reaction, reply and edited-flag details
-- simply stay local to each device until these columns exist.

alter table public.messages
  add column if not exists reactions text,
  add column if not exists reply_to text,
  add column if not exists edited boolean default false;
