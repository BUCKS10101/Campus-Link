-- QA audit CHAT-02/CHAT-03: chat_messages.message has no server-side
-- length or emptiness check - only the client's ChatMessageSchema
-- (validation.ts, 1-1000 chars, trimmed) enforces this today. Confirmed
-- empirically (2026-08-29 QA audit) that a direct API call bypassing
-- the frontend can insert an empty string or an arbitrarily long
-- message. Matches ratings.comment's own bounded-length convention
-- (20260827300000_ratings.sql: `char_length(comment) <= 300`) - this is
-- the same "the server, never the client, decides" discipline applied
-- to a column that never got it originally.
--
-- Bound is 1000, matching ChatMessageSchema's existing max exactly - not
-- a new product decision, just making the existing client-side number
-- real. Empty/whitespace-only messages are also rejected (trim() first,
-- so " " alone doesn't slip through as "non-empty").

alter table chat_messages
  add constraint chat_messages_message_length_check
  check (char_length(btrim(message)) > 0 and char_length(message) <= 1000);

-- ============ VERIFY AFTER APPLYING ============
-- Manual checks:
--   A direct insert with message = '' is rejected.
--   A direct insert with message = '   ' (whitespace only) is rejected.
--   A direct insert with message longer than 1000 chars is rejected.
--   A normal 1-1000 char message (including emoji/unicode) still
--     succeeds exactly as before - char_length counts characters, not
--     bytes, so multi-byte unicode isn't penalized.
