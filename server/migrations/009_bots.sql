-- Bot members (Settings → API → Bots): automation with its own role, project access and API keys.
-- A bot is a `users` row so its keys and rate limit work like a person's, but `kind = 'bot'` marks
-- it as one that can never sign in: no password, an address on the reserved `.invalid` TLD that no
-- mail can reach, and every sign-in, reset, verification and email path refuses it by this column.
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'bot'));

-- Who made a key: the person themselves, or for a bot's key the Owner/Admin who created it. An audit
-- trail only: removing that admin keeps the key (it belongs to the bot), so this is SET NULL.
ALTER TABLE api_keys ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
