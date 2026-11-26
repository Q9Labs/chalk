package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type presentingTestFixture struct {
	tenant, space, episode, participant, attachment utilities.ID
	subject                                         presenting.Subject
}

func newPresentingFixture(t *testing.T, pool *pgxpool.Pool, capabilities string) presentingTestFixture {
	t.Helper()
	ctx := context.Background()
	tenant, _ := utilities.NewID()
	space, _ := utilities.NewID()
	episode, _ := utilities.NewID()
	participant, _ := utilities.NewID()
	attachment, _ := utilities.NewID()
	upload, _ := utilities.NewID()
	mustExec(t, pool, `insert into tenants(id,name) values($1,'Presenting test')`, uuid(tenant))
	mustExec(t, pool, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Presenting test',$3,$4)`, uuid(space), uuid(tenant), "presenting-"+space.String(), string(mediaplane.ProviderChalkSFU))
	mustExec(t, pool, `insert into episodes(id,tenant_id,space_id,status,config_snapshot) values($1,$2,$3,'active','{}'::jsonb)`, uuid(episode), uuid(tenant), uuid(space))
	mustExec(t, pool, `insert into participants(id,tenant_id,space_id,episode_id,capabilities,generation,status,role) values($1,$2,$3,$4,$5::text[],1,'active','collaborator')`, uuid(participant), uuid(tenant), uuid(space), uuid(episode), capabilities)
	mustExec(t, pool, `insert into sync_chat_streams(tenant_id,space_id) values($1,$2)`, uuid(tenant), uuid(space))
	mustExec(t, pool, `insert into sync_chat_attachments(tenant_id,space_id,episode_id,attachment_id,participant_id,participant_generation,client_attachment_id,request_fingerprint,upload_id,object_key,original_filename,mime_type,byte_length,sha256,immutable_object_identity,status,expires_at,finalized_at)
		values($1,$2,$3,$4,$5,1,'client-attachment-1',repeat('a',32)::bytea,$6,$7,'deck.pdf','application/pdf',1024,repeat('b',32)::bytea,'object-version','ready',now()+interval '1 day',now())`,
		uuid(tenant), uuid(space), uuid(episode), uuid(attachment), uuid(participant), uuid(upload), "chat-attachments-v1/tenants/"+tenant.String()+"/episodes/"+episode.String()+"/uploads/"+upload.String())
	_ = ctx
	return presentingTestFixture{tenant: tenant, space: space, episode: episode, participant: participant, attachment: attachment, subject: presenting.Subject{TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, ParticipantGeneration: 1}}
}

func trackTestUploads(t *testing.T, repository PresentingRepository, lease presenting.RenderLease, pages ...int) {
	t.Helper()
	uploads := make([]presenting.RenderUpload, 0, len(pages)*2)
	for _, page := range pages {
		for _, rendition := range []string{"image", "thumbnail"} {
			uploads = append(uploads, presenting.RenderUpload{
				TenantID: lease.TenantID, SpaceID: lease.SpaceID, DocumentID: lease.DocumentID, JobID: lease.JobID,
				Page: page, Rendition: rendition, Attempt: lease.Attempt,
				ObjectKey: "test-presenting-upload/" + lease.DocumentID.String() + "/" + lease.JobID.String() + "/" + rendition + "-" + string(rune('0'+page)),
			})
		}
	}
	if err := repository.TrackRenderUploads(context.Background(), uploads); err != nil {
		t.Fatalf("track uploads: %v", err)
	}
}

func TestPresentingDocumentAccessAndIdempotencyIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	documentID, _ := utilities.NewID()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, documentID)
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	if !document.Created || document.DocumentID != documentID || document.InventoryJobID.IsZero() {
		t.Fatalf("unexpected document: %+v", document)
	}
	replacementID, _ := utilities.NewID()
	again, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, replacementID)
	if err != nil {
		t.Fatalf("repeat create document: %v", err)
	}
	if again.Created || again.DocumentID != documentID || !again.InventoryJobID.IsZero() {
		t.Fatalf("idempotent create returned %+v", again)
	}
	if _, err := repository.AuthorizedDocument(ctx, fixture.subject, documentID); err != nil {
		t.Fatalf("creator reads document: %v", err)
	}
}

func TestPresentingDocumentAccessDeniedIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()

	noCapability := newPresentingFixture(t, pool, "{publishAudio}")
	if _, err := repository.CreateDocument(ctx, noCapability.subject, noCapability.attachment, newTestID(t)); !errors.Is(err, presenting.ErrPermissionDenied) {
		t.Fatalf("no capability error = %v", err)
	}
	stranger, _ := utilities.NewID()
	nonParticipant := fixture.subject
	nonParticipant.ParticipantID = stranger
	if _, err := repository.CreateDocument(ctx, nonParticipant, fixture.attachment, newTestID(t)); !errors.Is(err, presenting.ErrPermissionDenied) {
		t.Fatalf("nonparticipant error = %v", err)
	}

	otherEpisode, _ := utilities.NewID()
	otherParticipant, _ := utilities.NewID()
	otherSpace, _ := utilities.NewID()
	mustExec(t, pool, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Presenting other',$3,$4)`, uuid(otherSpace), uuid(fixture.tenant), "presenting-other-"+otherSpace.String(), string(mediaplane.ProviderChalkSFU))
	mustExec(t, pool, `insert into episodes(id,tenant_id,space_id,status,config_snapshot) values($1,$2,$3,'active','{}'::jsonb)`, uuid(otherEpisode), uuid(fixture.tenant), uuid(otherSpace))
	mustExec(t, pool, `insert into participants(id,tenant_id,space_id,episode_id,capabilities,generation,status,role) values($1,$2,$3,$4,'{publishScreen}',1,'active','collaborator')`, uuid(otherParticipant), uuid(fixture.tenant), uuid(otherSpace), uuid(otherEpisode))
	otherSubject := presenting.Subject{TenantID: fixture.tenant, SpaceID: otherSpace, EpisodeID: otherEpisode, ParticipantID: otherParticipant, ParticipantGeneration: 1}
	if _, err := repository.CreateDocument(ctx, otherSubject, fixture.attachment, newTestID(t)); !errors.Is(err, presenting.ErrPermissionDenied) {
		t.Fatalf("other episode error = %v", err)
	}
}

func TestPresentingRenderFencingAndCompletionIdempotencyIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	inventoryJobID := document.InventoryJobID
	if inventoryJobID.IsZero() {
		t.Fatalf("document creation did not return its inventory job: %+v", document)
	}
	now := time.Now().UTC()
	token, _ := utilities.NewID()
	claimed, err := repository.ClaimRenderJob(ctx, inventoryJobID, 1, now, now.Add(time.Minute), token, "document-renderer")
	if err != nil {
		t.Fatalf("claim inventory job: %v", err)
	}
	lease := claimed.Job.RenderLease
	trackTestUploads(t, repository, lease, 1)
	report := presenting.InventoryReport{Lease: lease, PageCount: 2, Pages: []presenting.PageSpec{{Page: 1, Width: 1600, Height: 900}, {Page: 2, Width: 1600, Height: 900}}}
	jobs, err := repository.CompleteInventory(ctx, report, 25)
	if err != nil {
		t.Fatalf("complete inventory: %v", err)
	}
	if len(jobs) != 1 || jobs[0].PageStart != 2 || jobs[0].PageEnd != 2 {
		t.Fatalf("unexpected page jobs: %+v", jobs)
	}
	wrong := lease
	wrong.Attempt++
	if err := repository.CompleteRenderJob(ctx, wrong); !errors.Is(err, presenting.ErrLeaseLost) {
		t.Fatalf("wrong attempt completion error = %v", err)
	}
	pageToken, _ := utilities.NewID()
	claimNow := time.Now().UTC()
	pageClaim, err := repository.ClaimRenderJob(ctx, jobs[0].JobID, 1, claimNow, claimNow.Add(time.Minute), pageToken, "document-renderer")
	if err != nil {
		t.Fatalf("claim page job: %v", err)
	}
	pageLease := pageClaim.Job.RenderLease
	trackTestUploads(t, repository, pageLease, 2)
	badLease := pageLease
	badLease.LeaseToken, _ = utilities.NewID()
	if err := repository.MarkPageReady(ctx, badLease, 2); !errors.Is(err, presenting.ErrLeaseLost) {
		t.Fatalf("bad token page report error = %v", err)
	}
	if err := repository.MarkPageReady(ctx, pageLease, 2); err != nil {
		t.Fatalf("fenced page report: %v", err)
	}
	if err := repository.CompleteRenderJob(ctx, pageLease); err != nil {
		t.Fatalf("complete page job: %v", err)
	}
	if err := repository.CompleteRenderJob(ctx, pageLease); err != nil {
		t.Fatalf("repeated completion must be idempotent: %v", err)
	}
}
