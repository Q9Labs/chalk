package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/config"
)

func TestChatAttachmentQuotaFollowsThePersonAcrossRejoins(t *testing.T) {
	url := os.Getenv(config.DatabaseURL)
	if testing.Short() || url == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())

	tenantID, spaceID, episodeID, identityID := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	mustExec(t, tx, `insert into tenants(id,name) values($1,'chat attachment quota fixture')`, uuid(tenantID))
	mustExec(t, tx, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'chat attachment quota fixture',$3,'cf_sfu')`, uuid(spaceID), uuid(tenantID), spaceID.String())
	deadline := time.Now().Add(time.Hour)
	if _, err := sqlc.New(tx).CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{ID: uuid(episodeID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), DeadlineAt: timestamptz(&deadline), ArtifactPolicy: []byte(`{}`), MediaPlaneBinding: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	mustExec(t, tx, `insert into identities(id,tenant_id,kind,external_id,display_name) values($1,$2,'user',$3,'Ada')`, uuid(identityID), uuid(tenantID), identityID.String())
	participant := func(identity any) chatattachments.Subject {
		id := accountTenantIntegrationID(t)
		mustExec(t, tx, `insert into participants(id,tenant_id,space_id,episode_id,identity_id,generation,status,role,capabilities) values($1,$2,$3,$4,$5,1,'active','collaborator',array['sendChat'])`, uuid(id), uuid(tenantID), uuid(spaceID), uuid(episodeID), identity)
		return chatattachments.Subject{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: id, ParticipantGeneration: 1}
	}
	first, rejoined, other := participant(uuid(identityID)), participant(uuid(identityID)), participant(nil)

	repository := NewChatAttachmentRepository(tx)
	reserve := func(subject chatattachments.Subject, index int, byteLength int64) error {
		attachmentID, uploadID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
		_, err := repository.Reserve(ctx, chatattachments.ReserveInput{
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
		})
		return err
	}

	for index := range 40 {
		if err := reserve(first, index, 1); err != nil {
			t.Fatalf("reservation %d within the per-person cap: %v", index, err)
		}
	}
	if err := reserve(rejoined, 40, 1); !errors.Is(err, chatattachments.ErrQuotaExceeded) {
		t.Fatalf("the same person rejoined and reserved past the cap: %v", err)
	}
	for index := range 8 {
		if err := reserve(other, 100+index, 25*1024*1024); err != nil {
			t.Fatalf("another person's reservation %d within 200 MiB: %v", index, err)
		}
	}
	if err := reserve(other, 108, 1); !errors.Is(err, chatattachments.ErrQuotaExceeded) {
		t.Fatalf("another person reserved past 200 MiB: %v", err)
	}
}

func mustExec(t *testing.T, tx pgx.Tx, statement string, arguments ...any) {
	t.Helper()
	if _, err := tx.Exec(context.Background(), statement, arguments...); err != nil {
		t.Fatal(err)
	}
}
