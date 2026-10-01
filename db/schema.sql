CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  contact TEXT NOT NULL CHECK (length(contact) BETWEEN 2 AND 180),
  request TEXT NOT NULL CHECK (length(request) BETWEEN 2 AND 3000),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'work', 'wait')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  telegram_update_id BIGINT UNIQUE
);

CREATE TABLE IF NOT EXISTS tags (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_tags (
  lead_id BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, tag_id)
);

CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id BIGINT PRIMARY KEY,
  step TEXT NOT NULL CHECK (step IN ('name', 'contact', 'request')),
  name TEXT,
  contact TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id BIGINT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status);
CREATE INDEX IF NOT EXISTS leads_source_idx ON leads(source);
CREATE INDEX IF NOT EXISTS lead_tags_tag_idx ON lead_tags(tag_id, lead_id);
CREATE INDEX IF NOT EXISTS telegram_sessions_updated_idx ON telegram_sessions(updated_at);

INSERT INTO tags(name) VALUES ('Новый'), ('Горячий'), ('В работе'), ('Сайт'), ('Дизайн')
ON CONFLICT (name) DO NOTHING;
