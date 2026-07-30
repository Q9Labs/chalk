package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestChatAttachmentRepositoryReservesFirstStreamAndPreservesIdempotency(t *testing.T) {
	pool := chatAttachmentIntegrationPool(t)
	ctx := context.Background()
	subject := seedChatAttachmentSubject(t, pool)
	t.Cleanup(func() { cleanupChatAttachmentTenant(t, pool, subject.TenantID) })

	var digest [32]byte
	var fingerprint [32]byte
	for index := range digest {
		digest[index] = 0xaa
		fingerprint[index] = 0xbb
	}
	input := chatattachments.ReserveInput{
		Subject:            subject,
		ClientAttachmentID: "chat-file-client-0001",
		Upload: chatattachments.Upload{
			Attachment: chatattachments.Attachment{
				AttachmentID: chatAttachmentIntegrationID(t),
				FileName:     "diagram.png",
				MIMEType:     "image/png",
				ByteLength:   32,
			},
			UploadID:           chatAttachmentIntegrationID(t),
			ObjectKey:          "chat-attachments-v1/" + chatAttachmentIntegrationID(t).String(),
			SHA256:             digest,
			RequestFingerprint: fingerprint,
			Status:             "pending",
			ExpiresAt:          time.Now().Add(10 * time.Minute),
		},
	}
	repository := NewChatAttachmentRepository(pool)

	first, err := repository.Reserve(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := repository.Reserve(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if duplicate.AttachmentID != first.AttachmentID || duplicate.UploadID != first.UploadID {
		t.Fatalf("duplicate = %#v, first = %#v", duplicate, first)
	}

	changed := input
	changed.Upload.RequestFingerprint[0] = 0xcc
	if _, err := repository.Reserve(ctx, changed); !errors.Is(
		err,
		chatattachments.ErrClientAttachmentIDConflict,
	) {
		t.Fatalf("changed fingerprint error = %v", err)
	}

	var attachmentCount, attachmentBytes int64
	if err := pool.QueryRow(
		ctx,
		`select attachment_count, attachment_bytes
		 from sync_chat_streams
		 where tenant_id = $1 and session_id = $2`,
		uuid(subject.TenantID),
		uuid(subject.SessionID),
	).Scan(&attachmentCount, &attachmentBytes); err != nil {
		t.Fatal(err)
	}
	if attachmentCount != 1 || attachmentBytes != 32 {
		t.Fatalf(
			"reserved quota = (%d, %d), want (1, 32)",
			attachmentCount,
			attachmentBytes,
		)
	}
}

func TestChatAttachmentRepositoryFinalizesAndAuthorizesOwnerDownload(t *testing.T) {
	pool := chatAttachmentIntegrationPool(t)
	ctx := context.Background()
	subject := seedChatAttachmentSubject(t, pool)
	t.Cleanup(func() { cleanupChatAttachmentTenant(t, pool, subject.TenantID) })

	var digest [32]byte
	var fingerprint [32]byte
	uploadID := chatAttachmentIntegrationID(t)
	input := chatattachments.ReserveInput{
		Subject:            subject,
		ClientAttachmentID: "chat-file-client-0002",
		Upload: chatattachments.Upload{
			Attachment: chatattachments.Attachment{
				AttachmentID: chatAttachmentIntegrationID(t),
				FileName:     "notes.pdf",
				MIMEType:     "application/pdf",
				ByteLength:   64,
			},
			UploadID:           uploadID,
			ObjectKey:          "chat-attachments-v1/" + uploadID.String(),
			SHA256:             digest,
			RequestFingerprint: fingerprint,
			Status:             "pending",
			ExpiresAt:          time.Now().Add(10 * time.Minute),
		},
	}
	repository := NewChatAttachmentRepository(pool)
	reserved, err := repository.Reserve(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := repository.ClaimFinalize(ctx, subject, uploadID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Status != "finalizing" {
		t.Fatalf("claimed status = %q", claimed.Status)
	}
	if err := repository.Complete(ctx, chatattachments.CompleteInput{
		UploadID:                uploadID,
		ImmutableObjectIdentity: "immutable-etag",
		ExpiresAt:               time.Now().Add(24 * time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	ready, err := repository.AuthorizedDownload(ctx, subject, reserved.AttachmentID)
	if err != nil {
		t.Fatal(err)
	}
	if ready.Status != "ready" || ready.Attachment != reserved.Attachment {
		t.Fatalf("ready = %#v, reserved = %#v", ready, reserved)
	}
}

func seedChatAttachmentSubject(
	t *testing.T,
	pool *pgxpool.Pool,
) chatattachments.Subject {
	t.Helper()
	ctx := context.Background()
	subject := chatattachments.Subject{
		TenantID:              chatAttachmentIntegrationID(t),
		RoomID:                chatAttachmentIntegrationID(t),
		SessionID:             chatAttachmentIntegrationID(t),
		ParticipantSessionID:  chatAttachmentIntegrationID(t),
		ParticipantGeneration: 1,
	}
	if _, err := pool.Exec(
		ctx,
		"insert into tenants (id, name) values ($1, 'Chat attachment integration test')",
		uuid(subject.TenantID),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`insert into rooms (id, name, tenant_id, status, slug, media_plane)
		 values ($1, 'Chat attachment integration test', $2, 'active', $3, 'cf_sfu')`,
		uuid(subject.RoomID),
		uuid(subject.TenantID),
		"chat-attachment-"+subject.RoomID.String(),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`insert into room_sessions (id, status, room_id, tenant_id, started_at)
		 values ($1, 'active', $2, $3, now())`,
		uuid(subject.SessionID),
		uuid(subject.RoomID),
		uuid(subject.TenantID),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`insert into participants (
			id, name, capabilities, tenant_id, room_id, session_id,
			generation, status, role, eligible_roles
		) values (
			$1, 'Chat attachment test participant', '{"sendChat"}',
			$2, $3, $4, 1, 'active', 'participant', '{"participant"}'
		)`,
		uuid(subject.ParticipantSessionID),
		uuid(subject.TenantID),
		uuid(subject.RoomID),
		uuid(subject.SessionID),
	); err != nil {
		t.Fatal(err)
	}
	return subject
}

func cleanupChatAttachmentTenant(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID utilities.ID,
) {
	t.Helper()
	for _, table := range []string{
		"sync_chat_attachments",
		"sync_chat_read_receipts",
		"sync_chat_messages",
		"sync_chat_streams",
		"participants",
		"room_sessions",
		"rooms",
	} {
		if _, err := pool.Exec(
			context.Background(),
			"delete from "+table+" where tenant_id = $1",
			uuid(tenantID),
		); err != nil {
			t.Errorf("clean up %s: %v", table, err)
			return
		}
	}
	if _, err := pool.Exec(
		context.Background(),
		"delete from tenants where id = $1",
		uuid(tenantID),
	); err != nil {
		t.Errorf("clean up tenants: %v", err)
	}
}

func chatAttachmentIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("CHALK_CHAT_ATTACHMENT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_CHAT_ATTACHMENT_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	return pool
}

func chatAttachmentIntegrationID(t *testing.T) utilities.ID {
	t.Helper()
	value, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
