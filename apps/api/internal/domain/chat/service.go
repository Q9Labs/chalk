package chat

import (
    "context"
    "errors"
    "fmt"
    "io"
    "path/filepath"
    "strings"
    "time"

    "github.com/Q9Labs/chalk/internal/infrastructure/postgres"
    "github.com/Q9Labs/chalk/internal/infrastructure/storage"
    "github.com/google/uuid"
    "github.com/jackc/pgx/v5"
)

const (
    maxAttachmentSizeBytes = int64(25 * 1024 * 1024)
    maxAttachmentsPerBatch = 5
    presignExpiry          = 15 * time.Minute
)

var (
    ErrStorageUnavailable = errors.New("chat attachment storage unavailable")
    ErrInvalidAttachment  = errors.New("invalid attachment")
    ErrMessageEmpty       = errors.New("message content or attachments required")
)

type Service struct {
    pool      *postgres.Pool
    storageR2 storage.StorageClient
}

type Attachment struct {
    ID        uuid.UUID
    FileName  string
    MimeType  string
    SizeBytes int64
    Kind      string
}

type ReadReceipt struct {
    ParticipantID   uuid.UUID
    ParticipantName string
    ReadAt          time.Time
}

type Message struct {
    ID                  uuid.UUID
    SenderParticipantID uuid.UUID
    SenderIdentityKey   string
    SenderDisplayName   string
    Content             string
    CreatedAt           time.Time
    Attachments         []Attachment
    ReadBy              []ReadReceipt
}

type PendingAttachmentInput struct {
    FileName  string
    MimeType  string
    SizeBytes int64
}

type PendingAttachmentUpload struct {
    AttachmentID uuid.UUID
    UploadURL    string
    ExpiresAtMs  int64
    FileName     string
    MimeType     string
    SizeBytes    int64
    Kind         string
}

type DownloadURL struct {
    DownloadURL string
    ExpiresAtMs int64
}

type ReadUpdate struct {
    SenderIdentityKey string
    MessageIDs        []uuid.UUID
    ReaderParticipant uuid.UUID
    ReaderName        string
    ReadAt            time.Time
}

func NewService(pool *postgres.Pool, storageR2 storage.StorageClient) *Service {
    return &Service{pool: pool, storageR2: storageR2}
}

func (s *Service) ListRoomMessages(ctx context.Context, roomID, requesterParticipantID uuid.UUID) ([]Message, error) {
    requesterIdentityKey, _, err := s.resolveIdentity(ctx, requesterParticipantID)
    if err != nil {
        return nil, err
    }

    rows, err := s.pool.Query(ctx, `
        SELECT id, sender_participant_id, sender_identity_key, sender_display_name, content, created_at
        FROM chat_messages
        WHERE room_id = $1
        ORDER BY created_at ASC, id ASC
    `, roomID)
    if err != nil {
        return nil, fmt.Errorf("list chat messages: %w", err)
    }
    defer rows.Close()

    messages := make([]Message, 0)
    messageIndex := make(map[uuid.UUID]int)
    for rows.Next() {
        var message Message
        if scanErr := rows.Scan(
            &message.ID,
            &message.SenderParticipantID,
            &message.SenderIdentityKey,
            &message.SenderDisplayName,
            &message.Content,
            &message.CreatedAt,
        ); scanErr != nil {
            return nil, fmt.Errorf("scan chat message: %w", scanErr)
        }
        messageIndex[message.ID] = len(messages)
        messages = append(messages, message)
    }
    if rows.Err() != nil {
        return nil, fmt.Errorf("iterate chat messages: %w", rows.Err())
    }

    attachmentRows, err := s.pool.Query(ctx, `
        SELECT id, message_id, file_name, mime_type, size_bytes, kind
        FROM chat_attachments
        WHERE room_id = $1 AND message_id IS NOT NULL
        ORDER BY created_at ASC, id ASC
    `, roomID)
    if err != nil {
        return nil, fmt.Errorf("list chat attachments: %w", err)
    }
    defer attachmentRows.Close()

    for attachmentRows.Next() {
        var attachment Attachment
        var messageID uuid.UUID
        if scanErr := attachmentRows.Scan(&attachment.ID, &messageID, &attachment.FileName, &attachment.MimeType, &attachment.SizeBytes, &attachment.Kind); scanErr != nil {
            return nil, fmt.Errorf("scan chat attachment: %w", scanErr)
        }
        idx, ok := messageIndex[messageID]
        if !ok {
            continue
        }
        messages[idx].Attachments = append(messages[idx].Attachments, attachment)
    }
    if attachmentRows.Err() != nil {
        return nil, fmt.Errorf("iterate chat attachments: %w", attachmentRows.Err())
    }

    receiptRows, err := s.pool.Query(ctx, `
        SELECT r.message_id, r.reader_participant_id, r.reader_display_name, r.read_at
        FROM chat_message_reads r
        JOIN chat_messages m ON m.id = r.message_id
        WHERE m.room_id = $1 AND m.sender_identity_key = $2
        ORDER BY r.read_at ASC
    `, roomID, requesterIdentityKey)
    if err != nil {
        return nil, fmt.Errorf("list chat reads: %w", err)
    }
    defer receiptRows.Close()

    for receiptRows.Next() {
        var messageID uuid.UUID
        var receipt ReadReceipt
        if scanErr := receiptRows.Scan(&messageID, &receipt.ParticipantID, &receipt.ParticipantName, &receipt.ReadAt); scanErr != nil {
            return nil, fmt.Errorf("scan chat read: %w", scanErr)
        }
        idx, ok := messageIndex[messageID]
        if !ok || messages[idx].SenderIdentityKey != requesterIdentityKey {
            continue
        }
        messages[idx].ReadBy = append(messages[idx].ReadBy, receipt)
    }
    if receiptRows.Err() != nil {
        return nil, fmt.Errorf("iterate chat reads: %w", receiptRows.Err())
    }

    return messages, nil
}

func (s *Service) CreatePendingAttachments(ctx context.Context, roomID, participantID uuid.UUID, files []PendingAttachmentInput) ([]PendingAttachmentUpload, error) {
    if s.storageR2 == nil {
        return nil, ErrStorageUnavailable
    }
    if len(files) == 0 || len(files) > maxAttachmentsPerBatch {
        return nil, fmt.Errorf("attachment batch size must be between 1 and %d", maxAttachmentsPerBatch)
    }

    tx, err := s.pool.Begin(ctx)
    if err != nil {
        return nil, fmt.Errorf("begin chat attachment tx: %w", err)
    }
    defer func() {
        _ = tx.Rollback(ctx)
    }()

    uploads := make([]PendingAttachmentUpload, 0, len(files))
    expiresAt := time.Now().Add(presignExpiry)

    for _, file := range files {
        if file.SizeBytes <= 0 || file.SizeBytes > maxAttachmentSizeBytes {
            return nil, fmt.Errorf("attachment %q exceeds 25 MB", file.FileName)
        }

        attachmentID := uuid.New()
        fileName := sanitizeFileName(file.FileName)
        kind := attachmentKind(file.MimeType)
        storageKey := fmt.Sprintf("chat/rooms/%s/attachments/%s/%s", roomID, attachmentID, fileName)

        if _, execErr := tx.Exec(ctx, `
            INSERT INTO chat_attachments (
                id,
                room_id,
                uploaded_by_participant_id,
                file_name,
                mime_type,
                size_bytes,
                kind,
                storage_key,
                status
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
        `, attachmentID, roomID, participantID, fileName, strings.TrimSpace(file.MimeType), file.SizeBytes, kind, storageKey); execErr != nil {
            return nil, fmt.Errorf("insert chat attachment: %w", execErr)
        }

        uploadURL, urlErr := s.storageR2.GetPresignedUploadURL(ctx, storageKey, strings.TrimSpace(file.MimeType), presignExpiry)
        if urlErr != nil {
            return nil, fmt.Errorf("presign chat attachment upload: %w", urlErr)
        }

        uploads = append(uploads, PendingAttachmentUpload{
            AttachmentID: attachmentID,
            UploadURL:    uploadURL,
            ExpiresAtMs:  expiresAt.UnixMilli(),
            FileName:     fileName,
            MimeType:     strings.TrimSpace(file.MimeType),
            SizeBytes:    file.SizeBytes,
            Kind:         kind,
        })
    }

    if err = tx.Commit(ctx); err != nil {
        return nil, fmt.Errorf("commit chat attachment tx: %w", err)
    }

    return uploads, nil
}

func (s *Service) GetAttachmentDownloadURL(ctx context.Context, roomID, attachmentID uuid.UUID) (*DownloadURL, error) {
    if s.storageR2 == nil {
        return nil, ErrStorageUnavailable
    }

    var storageKey string
    err := s.pool.QueryRow(ctx, `
        SELECT storage_key
        FROM chat_attachments
        WHERE room_id = $1 AND id = $2 AND message_id IS NOT NULL
    `, roomID, attachmentID).Scan(&storageKey)
    if err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            return nil, ErrInvalidAttachment
        }
        return nil, fmt.Errorf("load chat attachment: %w", err)
    }

    downloadURL, err := s.storageR2.GetPresignedURL(ctx, storageKey, presignExpiry)
    if err != nil {
        return nil, fmt.Errorf("presign chat attachment download: %w", err)
    }

    return &DownloadURL{
        DownloadURL: downloadURL,
        ExpiresAtMs: time.Now().Add(presignExpiry).UnixMilli(),
    }, nil
}

func (s *Service) UploadPendingAttachment(ctx context.Context, roomID, participantID, attachmentID uuid.UUID, body io.Reader, contentType string) error {
    if s.storageR2 == nil {
        return ErrStorageUnavailable
    }

    var storageKey string
    var mimeType string
    err := s.pool.QueryRow(ctx, `
        SELECT storage_key, mime_type
        FROM chat_attachments
        WHERE room_id = $1
          AND id = $2
          AND uploaded_by_participant_id = $3
          AND message_id IS NULL
    `, roomID, attachmentID, participantID).Scan(&storageKey, &mimeType)
    if err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            return ErrInvalidAttachment
        }
        return fmt.Errorf("load pending chat attachment: %w", err)
    }

    resolvedContentType := strings.TrimSpace(contentType)
    if resolvedContentType == "" {
        resolvedContentType = mimeType
    }
    if resolvedContentType == "" {
        resolvedContentType = "application/octet-stream"
    }

    if err = s.storageR2.Upload(ctx, storageKey, body, resolvedContentType); err != nil {
        return fmt.Errorf("upload chat attachment: %w", err)
    }

    return nil
}

func (s *Service) CreateMessage(ctx context.Context, roomID, senderParticipantID uuid.UUID, content string, attachmentIDs []uuid.UUID) (*Message, error) {
    trimmedContent := strings.TrimSpace(content)
    if trimmedContent == "" && len(attachmentIDs) == 0 {
        return nil, ErrMessageEmpty
    }

    senderIdentityKey, senderDisplayName, err := s.resolveIdentity(ctx, senderParticipantID)
    if err != nil {
        return nil, err
    }

    tx, err := s.pool.Begin(ctx)
    if err != nil {
        return nil, fmt.Errorf("begin chat message tx: %w", err)
    }
    defer func() {
        _ = tx.Rollback(ctx)
    }()

    messageID := uuid.New()
    createdAt := time.Now().UTC()

    if _, execErr := tx.Exec(ctx, `
        INSERT INTO chat_messages (
            id,
            room_id,
            sender_participant_id,
            sender_identity_key,
            sender_display_name,
            content,
            created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, messageID, roomID, senderParticipantID, senderIdentityKey, senderDisplayName, trimmedContent, createdAt); execErr != nil {
        return nil, fmt.Errorf("insert chat message: %w", execErr)
    }

    attachments := make([]Attachment, 0, len(attachmentIDs))
    for _, attachmentID := range attachmentIDs {
        var attachment Attachment
        if scanErr := tx.QueryRow(ctx, `
            UPDATE chat_attachments
            SET message_id = $1, status = 'attached'
            WHERE id = $2
              AND room_id = $3
              AND uploaded_by_participant_id = $4
              AND message_id IS NULL
            RETURNING id, file_name, mime_type, size_bytes, kind
        `, messageID, attachmentID, roomID, senderParticipantID).Scan(&attachment.ID, &attachment.FileName, &attachment.MimeType, &attachment.SizeBytes, &attachment.Kind); scanErr != nil {
            if errors.Is(scanErr, pgx.ErrNoRows) {
                return nil, ErrInvalidAttachment
            }
            return nil, fmt.Errorf("attach chat attachment: %w", scanErr)
        }
        attachments = append(attachments, attachment)
    }

    if err = tx.Commit(ctx); err != nil {
        return nil, fmt.Errorf("commit chat message tx: %w", err)
    }

    return &Message{
        ID:                  messageID,
        SenderParticipantID: senderParticipantID,
        SenderIdentityKey:   senderIdentityKey,
        SenderDisplayName:   senderDisplayName,
        Content:             trimmedContent,
        CreatedAt:           createdAt,
        Attachments:         attachments,
        ReadBy:              []ReadReceipt{},
    }, nil
}

func (s *Service) MarkReadThrough(ctx context.Context, roomID, participantID, readThroughMessageID uuid.UUID) ([]ReadUpdate, error) {
    readerIdentityKey, readerName, err := s.resolveIdentity(ctx, participantID)
    if err != nil {
        return nil, err
    }

    tx, err := s.pool.Begin(ctx)
    if err != nil {
        return nil, fmt.Errorf("begin chat read tx: %w", err)
    }
    defer func() {
        _ = tx.Rollback(ctx)
    }()

    var readThroughCreatedAt time.Time
    if scanErr := tx.QueryRow(ctx, `
        SELECT created_at
        FROM chat_messages
        WHERE room_id = $1 AND id = $2
    `, roomID, readThroughMessageID).Scan(&readThroughCreatedAt); scanErr != nil {
        if errors.Is(scanErr, pgx.ErrNoRows) {
            return nil, nil
        }
        return nil, fmt.Errorf("load read-through message: %w", scanErr)
    }

    rows, err := tx.Query(ctx, `
        SELECT id, sender_identity_key
        FROM chat_messages
        WHERE room_id = $1
          AND created_at <= $2
          AND sender_identity_key <> $3
        ORDER BY created_at ASC, id ASC
    `, roomID, readThroughCreatedAt, readerIdentityKey)
    if err != nil {
        return nil, fmt.Errorf("list read-through messages: %w", err)
    }
    defer rows.Close()

    readAt := time.Now().UTC()
    grouped := make(map[string][]uuid.UUID)
    for rows.Next() {
        var messageID uuid.UUID
        var senderIdentityKey string
        if scanErr := rows.Scan(&messageID, &senderIdentityKey); scanErr != nil {
            return nil, fmt.Errorf("scan read-through message: %w", scanErr)
        }
        tag, execErr := tx.Exec(ctx, `
            INSERT INTO chat_message_reads (
                message_id,
                reader_participant_id,
                reader_identity_key,
                reader_display_name,
                read_at
            ) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (message_id, reader_identity_key) DO NOTHING
        `, messageID, participantID, readerIdentityKey, readerName, readAt)
        if execErr != nil {
            return nil, fmt.Errorf("insert chat read: %w", execErr)
        }
        if tag.RowsAffected() > 0 {
            grouped[senderIdentityKey] = append(grouped[senderIdentityKey], messageID)
        }
    }
    if rows.Err() != nil {
        return nil, fmt.Errorf("iterate read-through messages: %w", rows.Err())
    }

    if err = tx.Commit(ctx); err != nil {
        return nil, fmt.Errorf("commit chat read tx: %w", err)
    }

    updates := make([]ReadUpdate, 0, len(grouped))
    for senderIdentityKey, messageIDs := range grouped {
        updates = append(updates, ReadUpdate{
            SenderIdentityKey: senderIdentityKey,
            MessageIDs:        messageIDs,
            ReaderParticipant: participantID,
            ReaderName:        readerName,
            ReadAt:            readAt,
        })
    }

    return updates, nil
}

func (s *Service) resolveIdentity(ctx context.Context, participantID uuid.UUID) (string, string, error) {
    var identityKey string
    var displayName string
    err := s.pool.QueryRow(ctx, `
        SELECT COALESCE(NULLIF(external_user_id, ''), id::text), COALESCE(display_name, '')
        FROM participants
        WHERE id = $1
    `, participantID).Scan(&identityKey, &displayName)
    if err != nil {
        return "", "", fmt.Errorf("load participant identity: %w", err)
    }
    return identityKey, displayName, nil
}

func sanitizeFileName(name string) string {
    trimmed := strings.TrimSpace(name)
    if trimmed == "" {
        return "attachment"
    }
    base := filepath.Base(trimmed)
    base = strings.ReplaceAll(base, "..", "")
    base = strings.ReplaceAll(base, "/", "-")
    base = strings.ReplaceAll(base, "\\", "-")
    if base == "" || base == "." {
        return "attachment"
    }
    return base
}

func attachmentKind(mimeType string) string {
    mimeType = strings.ToLower(strings.TrimSpace(mimeType))
    switch {
    case strings.HasPrefix(mimeType, "image/"):
        return "image"
    case strings.Contains(mimeType, "pdf") || strings.Contains(mimeType, "word") || strings.Contains(mimeType, "sheet") || strings.Contains(mimeType, "excel") || strings.Contains(mimeType, "powerpoint") || strings.Contains(mimeType, "presentation") || strings.Contains(mimeType, "document") || strings.HasPrefix(mimeType, "text/"):
        return "document"
    default:
        return "file"
    }
}
