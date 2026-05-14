-- Durable in-room chat history, attachments, and read receipts

CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    sender_participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    sender_identity_key TEXT NOT NULL,
    sender_display_name VARCHAR(255) NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_room_created_at
    ON chat_messages (room_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS chat_attachments (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id UUID REFERENCES chat_messages(id) ON DELETE CASCADE,
    uploaded_by_participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(255) NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('image', 'document', 'file')),
    storage_key VARCHAR(500) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_room_created_at
    ON chat_attachments (room_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_message_id
    ON chat_attachments (message_id);

CREATE TABLE IF NOT EXISTS chat_message_reads (
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    reader_participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    reader_identity_key TEXT NOT NULL,
    reader_display_name VARCHAR(255) NOT NULL DEFAULT '',
    read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, reader_identity_key)
);

CREATE INDEX IF NOT EXISTS idx_chat_message_reads_participant_read_at
    ON chat_message_reads (reader_participant_id, read_at DESC);
