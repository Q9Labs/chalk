package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The real-browser proof disables the automatic deadline scheduler and invokes
// exactly one production scheduler transaction after rotating a waiting invite.
func TestPublicAdmissionInvalidationOneSchedulerTick(t *testing.T) {
	handle := os.Getenv("CHALK_PROOF_INVALIDATED_REQUEST")
	if handle == "" {
		t.Skip("run the real admission invalidation browser proof")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, os.Getenv("CHALK_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var terminal bool
	if err := pool.QueryRow(ctx, `select arrivals.state in ('unavailable','rejected','left') and requests.expires_at > now()+interval '4 minutes' from space_public_admission_requests public join space_public_arrivals arrivals on arrivals.tenant_id=public.tenant_id and arrivals.arrival_handle=public.arrival_handle join sync_admission_requests requests on requests.tenant_id=public.tenant_id and requests.admission_request_id=public.request_handle where public.request_handle=$1::uuid`, handle).Scan(&terminal); err != nil || !terminal {
		t.Fatalf("fixture must be terminal well before its deadline: terminal=%v err=%v", terminal, err)
	}
	count, err := NewEpisodeLifecycleRepository(pool).EnqueueDueEpisodeDeadlines(ctx, 50)
	if err != nil || count != 1 {
		t.Fatalf("one scheduler tick: count=%d err=%v", count, err)
	}
	deadline := time.Now().Add(10 * time.Second)
	var admission, participant, public string
	for {
		err := pool.QueryRow(ctx, `select requests.status, participants.status, public.state from sync_admission_requests requests join participants on participants.tenant_id=requests.tenant_id and participants.id=requests.participant_id join space_public_admission_requests public on public.tenant_id=requests.tenant_id and public.request_handle=requests.admission_request_id where requests.admission_request_id=$1::uuid`, handle).Scan(&admission, &participant, &public)
		if err != nil {
			t.Fatal(err)
		}
		if admission == "expired" && participant == "left" && public == "expired" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("invalidation did not settle after one scheduler tick: admission=%s participant=%s public=%s", admission, participant, public)
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Log("one scheduler tick settled invalidated arrival with >4 minutes remaining; admission=expired participant=left public=expired")
}
