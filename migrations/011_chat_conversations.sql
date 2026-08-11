CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New conversation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_conversation_title_length CHECK (char_length(title) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_updated
  ON chat_conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  tool_receipts JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_message_role CHECK (role IN ('user', 'assistant')),
  CONSTRAINT chat_message_mode CHECK (mode IN ('hybrid', 'llm_only')),
  CONSTRAINT chat_message_content_length CHECK (char_length(content) BETWEEN 1 AND 200000),
  CONSTRAINT chat_message_token_counts CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND total_tokens >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created
  ON chat_messages(conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_user_created
  ON chat_messages(user_id, created_at DESC);
