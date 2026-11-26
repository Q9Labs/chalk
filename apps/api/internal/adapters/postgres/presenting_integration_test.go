package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
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
	mustExec(t, pool, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Presenting test',$3,'chalk_sfu')`, uuid(space), uuid(tenant), "presenting-"+space.String())
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
	mustExec(t, pool, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Presenting other',$3,'chalk_sfu')`, uuid(otherSpace), uuid(fixture.tenant), "presenting-other-"+otherSpace.String())
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

func TestPresentingOnePageRenderLifecycleIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	if document.InventoryJobID.IsZero() {
		t.Fatal("document creation did not atomically create an inventory job")
	}
	now := time.Now().UTC()
	token, _ := utilities.NewID()
	claimed, err := repository.ClaimRenderJob(ctx, document.InventoryJobID, 1, now, now.Add(time.Minute), token, "document-renderer")
	if err != nil {
		t.Fatalf("claim inventory job: %v", err)
	}
	lease := claimed.Job.RenderLease
	trackTestUploads(t, repository, lease, 1)
	report := presenting.InventoryReport{Lease: lease, PageCount: 1, Pages: []presenting.PageSpec{{Page: 1, Width: 1600, Height: 900}}}
	jobs, err := repository.CompleteInventory(ctx, report, 25)
	if err != nil {
		t.Fatalf("complete one-page inventory: %v", err)
	}
	if len(jobs) != 0 {
		t.Fatalf("one-page document fanned out unexpectedly: %+v", jobs)
	}
	stored, err := repository.AuthorizedDocument(ctx, fixture.subject, document.DocumentID)
	if err != nil {
		t.Fatalf("read completed document: %v", err)
	}
	if stored.Status != "ready" || stored.PageCount != 1 {
		t.Fatalf("one-page document status = %+v", stored)
	}
	pages, err := repository.ListPages(ctx, stored)
	if err != nil {
		t.Fatalf("list pages: %v", err)
	}
	if len(pages) != 1 || pages[0].Status != "ready" || pages[0].ImageKey == "" || pages[0].ThumbnailKey == "" {
		t.Fatalf("published page = %+v", pages)
	}
	if err := repository.CompleteRenderJob(ctx, lease); err != nil {
		t.Fatalf("repeated inventory completion must be idempotent: %v", err)
	}
}

func TestPresentingExpiredLeaseCannotCompleteOrFailRenderJobIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		fail bool
	}{
		{name: "complete"},
		{name: "fail", fail: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newPresentingFixture(t, pool, "{publishScreen}")
			document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
			if err != nil {
				t.Fatalf("create document: %v", err)
			}
			now := time.Now().UTC()
			token, _ := utilities.NewID()
			claimed, err := repository.ClaimRenderJob(ctx, document.InventoryJobID, 1, now, now.Add(-time.Second), token, "document-renderer")
			if err != nil {
				t.Fatalf("claim inventory job: %v", err)
			}
			lease := claimed.Job.RenderLease
			if tc.fail {
				err = repository.FailRenderJob(ctx, lease, presenting.RenderFailure{Code: "corrupt", Message: "corrupt source"})
			} else {
				err = repository.CompleteRenderJob(ctx, lease)
			}
			if !errors.Is(err, presenting.ErrLeaseLost) {
				t.Fatalf("expired lease callback error = %v", err)
			}
			var status string
			if err := pool.QueryRow(ctx, `select status from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID), uuid(lease.JobID)).Scan(&status); err != nil {
				t.Fatalf("read job status: %v", err)
			}
			if status != "leased" {
				t.Fatalf("expired lease changed job status to %q", status)
			}
		})
	}
}

func TestPresentingRenderCompletionIsAtomicWithDocumentReadinessIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	jobID := newTestID(t)
	mustExec(t, pool, `insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,available_at)
		values($1,$2,$3,$4,'pages',1,1,'queued',now())`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID), uuid(jobID))
	now := time.Now().UTC()
	token, _ := utilities.NewID()
	claimed, err := repository.ClaimRenderJob(ctx, jobID, 1, now, now.Add(time.Minute), token, "document-renderer")
	if err != nil {
		t.Fatalf("claim page job: %v", err)
	}
	lease := claimed.Job.RenderLease
	mustExec(t, pool, `update presenting_documents set page_count=1 where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID))
	mustExec(t, pool, `insert into presenting_document_pages(tenant_id,space_id,document_id,page,width,height,status,image_key,thumbnail_key)
		values($1,$2,$3,1,1600,900,'ready','test-image','test-thumbnail')`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID))
	mustExec(t, pool, `create or replace function presenting_test_abort_ready_completion() returns trigger language plpgsql as $$
begin
	if NEW.status = 'ready' and OLD.status is distinct from 'ready' then
		raise exception 'presenting test abort ready completion';
	end if;
	return NEW;
end
$$`)
	mustExec(t, pool, `create trigger presenting_test_abort_ready_completion before update on presenting_documents for each row execute function presenting_test_abort_ready_completion()`)
	t.Cleanup(func() {
		mustExec(t, pool, `drop trigger if exists presenting_test_abort_ready_completion on presenting_documents`)
		mustExec(t, pool, `drop function if exists presenting_test_abort_ready_completion()`)
	})

	if err := repository.CompleteRenderJob(ctx, lease); err == nil {
		t.Fatal("completion unexpectedly succeeded past the document trigger")
	}
	var jobStatus, documentStatus string
	if err := pool.QueryRow(ctx, `select status from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID), uuid(lease.JobID)).Scan(&jobStatus); err != nil {
		t.Fatalf("read job status: %v", err)
	}
	if err := pool.QueryRow(ctx, `select status from presenting_documents where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID)).Scan(&documentStatus); err != nil {
		t.Fatalf("read document status: %v", err)
	}
	if jobStatus != "leased" || documentStatus != "preparing" {
		t.Fatalf("interrupted completion left job=%q document=%q", jobStatus, documentStatus)
	}
}

func TestPresentingZoomFailureLeavesReadyDocumentIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	mustExec(t, pool, `update presenting_documents set status='ready', page_count=1 where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID))
	mustExec(t, pool, `insert into presenting_document_pages(tenant_id,space_id,document_id,page,width,height,status,image_key,thumbnail_key)
		values($1,$2,$3,1,1600,900,'ready','test-image','test-thumbnail')`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID))
	now := time.Now().UTC()
	job, created, err := repository.EnsureZoomJob(ctx, document, 1, now)
	if err != nil || !created {
		t.Fatalf("create zoom job created=%v err=%v", created, err)
	}
	token, _ := utilities.NewID()
	claimed, err := repository.ClaimRenderJob(ctx, job.JobID, 1, now, now.Add(time.Minute), token, "document-renderer")
	if err != nil {
		t.Fatalf("claim zoom job: %v", err)
	}
	lease := claimed.Job.RenderLease
	if err := repository.FailRenderJob(ctx, lease, presenting.RenderFailure{Code: "corrupt", Message: "zoom render failed"}); err != nil {
		t.Fatalf("fail zoom job: %v", err)
	}
	var jobStatus, documentStatus string
	if err := pool.QueryRow(ctx, `select status from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID), uuid(lease.JobID)).Scan(&jobStatus); err != nil {
		t.Fatalf("read zoom job status: %v", err)
	}
	if err := pool.QueryRow(ctx, `select status from presenting_documents where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID)).Scan(&documentStatus); err != nil {
		t.Fatalf("read document status: %v", err)
	}
	if jobStatus != "failed" || documentStatus != "ready" {
		t.Fatalf("zoom failure left job=%q document=%q", jobStatus, documentStatus)
	}
}

func TestPresentingFinalRenderAttemptTimeoutFailsDocumentIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	realNow := time.Now().UTC()
	claimNow := realNow.Add(2 * time.Second)
	leaseUntil := realNow.Add(-time.Minute)
	var lease presenting.RenderLease
	for attempt := 1; attempt <= presenting.RenderAttemptLimit; attempt++ {
		token, _ := utilities.NewID()
		claimed, err := repository.ClaimRenderJob(ctx, document.InventoryJobID, attempt, claimNow, leaseUntil, token, "document-renderer")
		if err != nil {
			t.Fatalf("claim attempt %d: %v", attempt, err)
		}
		lease = claimed.Job.RenderLease
		claimNow = claimNow.Add(time.Second)
	}
	jobs, err := repository.ListStaleRenderJobs(ctx, claimNow, 10)
	if err != nil {
		t.Fatalf("list stale jobs: %v", err)
	}
	if len(jobs) != 0 {
		t.Fatalf("final expired attempt was offered for another retry: %+v", jobs)
	}
	var jobStatus, documentStatus string
	if err := pool.QueryRow(ctx, `select status from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID), uuid(lease.JobID)).Scan(&jobStatus); err != nil {
		t.Fatalf("read job status: %v", err)
	}
	if err := pool.QueryRow(ctx, `select status from presenting_documents where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID)).Scan(&documentStatus); err != nil {
		t.Fatalf("read document status: %v", err)
	}
	if jobStatus != "failed" || documentStatus != "failed" {
		t.Fatalf("final timeout left job=%q document=%q", jobStatus, documentStatus)
	}
}
