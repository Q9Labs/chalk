package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/config"
)

func TestChatAttachmentQuotaFollowsThePersonAcrossRejoins(t *testing.T) {
	ctx, pool := chatAttachmentQuotaPool(t)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())

	participant := chatAttachmentQuotaFixture(ctx, t, tx)
	first, rejoined, other := participant(true), participant(true), participant(false)
	repository := NewChatAttachmentRepository(tx)
	reserve := func(input chatattachments.ReserveInput) error {
		_, err := repository.Reserve(ctx, input)
		return err
	}

	held := make([]chatattachments.ReserveInput, 0, 40)
	for index := range 40 {
		held = append(held, chatAttachmentReservation(t, first, index, 1))
		if err := reserve(held[index]); err != nil {
			t.Fatalf("reservation %d within the per-person cap: %v", index, err)
		}
	}
	if err := reserve(chatAttachmentReservation(t, rejoined, 40, 1)); !errors.Is(err, chatattachments.ErrQuotaExceeded) {
		t.Fatalf("the same person rejoined and reserved past the cap: %v", err)
	}
	retried, err := repository.Reserve(ctx, held[39])
	if err != nil || retried.UploadID != held[39].Upload.UploadID {
		t.Fatalf("a retry of a stored reservation at the cap did not return it: %v", err)
	}
	for index := range 8 {
		if err := reserve(chatAttachmentReservation(t, other, 100+index, 25*1024*1024)); err != nil {
			t.Fatalf("another person's reservation %d within 200 MiB: %v", index, err)
		}
	}
	if err := reserve(chatAttachmentReservation(t, other, 108, 1)); !errors.Is(err, chatattachments.ErrQuotaExceeded) {
		t.Fatalf("another person reserved past 200 MiB: %v", err)
	}

	mustExec(t, tx, `update participants set status = 'left', left_at = now(), last_left_reason = 'left' where id = $1`, uuid(first.ParticipantID))
	if err := reserve(held[0]); !errors.Is(err, chatattachments.ErrQuotaExceeded) {
		t.Fatalf("a Participant who left got its stored reservation back: %v", err)
	}
}

func TestChatAttachmentQuotaHoldsForConcurrentReservations(t *testing.T) {
	ctx, pool := chatAttachmentQuotaPool(t)
	participant := chatAttachmentQuotaFixture(ctx, t, pool)
	sender := participant(true)
	repository := NewChatAttachmentRepository(pool)
	for index := range 39 {
		if _, err := repository.Reserve(ctx, chatAttachmentReservation(t, sender, index, 1)); err != nil {
			t.Fatalf("reservation %d within the per-person cap: %v", index, err)
		}
	}

	// Hold the Space's stream row so every racing reservation starts before any of them commits.
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	mustExec(t, blocker, `select 1 from sync_chat_streams where tenant_id = $1 and space_id = $2 for update`, uuid(sender.TenantID), uuid(sender.SpaceID))

	const racers = 8
	results := make(chan error, racers)
	var started sync.WaitGroup
	for index := range racers {
		started.Add(1)
		go func() {
			started.Done()
			_, err := repository.Reserve(ctx, chatAttachmentReservation(t, sender, 100+index, 1))
			results <- err
		}()
	}
	started.Wait()
	time.Sleep(300 * time.Millisecond)
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	accepted := 0
	for range racers {
		err := <-results
		switch {
		case err == nil:
			accepted++
		case !errors.Is(err, chatattachments.ErrQuotaExceeded):
			t.Fatalf("racing reservation: %v", err)
		}
	}
	if accepted != 1 {
		t.Fatalf("%d racing reservations passed a cap with one slot left", accepted)
	}
}

func chatAttachmentQuotaPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv(config.DatabaseURL)
	if testing.Short() || url == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}

// chatAttachmentQuotaFixture seeds one Space and returns a function that adds a Participant to it,
// either as the same identity each time or as a new person.
func chatAttachmentQuotaFixture(ctx context.Context, t *testing.T, db sqlc.DBTX) func(samePerson bool) chatattachments.Subject {
	t.Helper()
	tenantID, spaceID, episodeID, identityID := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	mustExec(t, db, `insert into tenants(id,name) values($1,'chat attachment quota fixture')`, uuid(tenantID))
	t.Cleanup(func() {
		cleanup := context.Background()
		for _, statement := range []string{
			`delete from sync_chat_attachments where tenant_id = $1`,
			`delete from sync_chat_streams where tenant_id = $1`,
			`delete from participants where tenant_id = $1`,
			`delete from identities where tenant_id = $1`,
			`delete from episodes where tenant_id = $1`,
			`delete from spaces where tenant_id = $1`,
			`delete from tenants where id = $1`,
		} {
			// Inside a test transaction the rows are already gone with the rollback.
			_, _ = db.Exec(cleanup, statement, uuid(tenantID))
		}
	})
	mustExec(t, db, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'chat attachment quota fixture',$3,'cf_sfu')`, uuid(spaceID), uuid(tenantID), spaceID.String())
	deadline := time.Now().Add(time.Hour)
	if _, err := sqlc.New(db).CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{ID: uuid(episodeID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), DeadlineAt: timestamptz(&deadline), ArtifactPolicy: []byte(`{}`), MediaPlaneBinding: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, `insert into identities(id,tenant_id,kind,external_id,display_name) values($1,$2,'user',$3,'Ada')`, uuid(identityID), uuid(tenantID), identityID.String())
	return func(samePerson bool) chatattachments.Subject {
		id := accountTenantIntegrationID(t)
		var identity any
		if samePerson {
			identity = uuid(identityID)
		}
		mustExec(t, db, `insert into participants(id,tenant_id,space_id,episode_id,identity_id,generation,status,role,capabilities) values($1,$2,$3,$4,$5,1,'active','collaborator',array['sendChat'])`, uuid(id), uuid(tenantID), uuid(spaceID), uuid(episodeID), identity)
		return chatattachments.Subject{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: id, ParticipantGeneration: 1}
	}
}

func chatAttachmentReservation(t *testing.T, subject chatattachments.Subject, index int, byteLength int64) chatattachments.ReserveInput {
	t.Helper()
	attachmentID, uploadID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	return chatattachments.ReserveInput{
		Subject:            subject,
		ClientAttachmentID: fmt.Sprintf("quota-attachment-%04d", index),
		Upload: chatattachments.Upload{
			Attachment:         chatattachments.Attachment{AttachmentID: attachmentID, FileName: "note.txt", MIMEType: "text/plain", ByteLength: byteLength},
			UploadID:           uploadID,
			ObjectKey:          "chat/" + uploadID.String(),
			SHA256:             sha256.Sum256([]byte(uploadID.String())),
			RequestFingerprint: sha256.Sum256([]byte(attachmentID.String())),
			ExpiresAt:          time.Now().Add(time.Hour),
		},
	}
}

func mustExec(t *testing.T, db sqlc.DBTX, statement string, arguments ...any) {
	t.Helper()
	if _, err := db.Exec(context.Background(), statement, arguments...); err != nil {
		t.Fatal(err)
	}
}
