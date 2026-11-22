package postgres

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/helperaccess"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type activeHelperShare struct{}

func (activeHelperShare) CurrentAnnotationShare(context.Context, accessgrants.Subject, utilities.ID, string) (bool, error) {
	return true, nil
}

type pausedHelperShare struct {
	started chan struct{}
	resume  chan struct{}
}

func (s pausedHelperShare) CurrentAnnotationShare(ctx context.Context, _ accessgrants.Subject, _ utilities.ID, _ string) (bool, error) {
	close(s.started)
	select {
	case <-s.resume:
		return true, nil
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

func TestHelperDeviceApprovalAndRevocation(t *testing.T) {
	url := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if testing.Short() || url == "" {
		t.Skip("requires a migrated test database")
	}
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	tenants := [2]utilities.ID{accountTenantIntegrationID(t), accountTenantIntegrationID(t)}
	for _, tenant := range tenants {
		if _, err := pool.Exec(ctx, "insert into tenants(id, name) values($1, 'Helper device test')", uuid(tenant)); err != nil {
			t.Fatal(err)
		}
		defer func() {
			_, _ = pool.Exec(context.Background(), "delete from tenants where id = $1", uuid(tenant))
		}()
	}
	_, signer, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	store := NewEpisodeLifecycleRepository(pool)
	service := helperaccess.NewService(activeHelperShare{}, "test", "test", signer).WithDevices(store)
	secret := func() string {
		t.Helper()
		var data [32]byte
		if _, err := rand.Read(data[:]); err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(data[:])
	}
	key, credential, poll := secret(), secret(), secret()
	code, err := service.StartDevice(ctx, tenants[0], "Proof device", key, credential, poll, false)
	if err != nil {
		t.Fatal(err)
	}
	pending, err := service.PollDevice(ctx, poll)
	if err != nil || pending.Attachment != nil {
		t.Fatalf("unapproved device received a ticket: %v", err)
	}
	t.Run("only intended tenant can look up a pending code", func(t *testing.T) {
		if _, err := service.LookupDevice(ctx, tenants[1], code.Code); !errors.Is(err, helperaccess.ErrDeviceUnavailable) {
			t.Fatalf("unrelated signed-in tenant learned the pending code details: %v", err)
		}
	})
	offer, err := service.LookupDevice(ctx, tenants[0], code.Code)
	if err != nil || offer.Name != "Proof device" {
		t.Fatalf("lookup offer = %+v, %v", offer, err)
	}
	requestID, err := utilities.ParseID(offer.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	subject := accessgrants.Subject{
		TenantID: tenants[0], SpaceID: accountTenantIntegrationID(t), EpisodeID: accountTenantIntegrationID(t),
		ParticipantID: accountTenantIntegrationID(t), ParticipantGeneration: 3, ConnectionID: "helper-proof-connection",
	}
	layer := accountTenantIntegrationID(t)
	publication := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"helper-proof-connection","m":"1","t":"screen","g":3}`))
	if err := service.ApproveDevice(ctx, tenants[1], requestID, subject, layer, publication, false); !errors.Is(err, helperaccess.ErrShareNotCurrent) {
		t.Fatalf("another signed-in tenant approved this participant: %v", err)
	}
	otherSubject := subject
	otherSubject.TenantID = tenants[1]
	if err := service.ApproveDevice(ctx, tenants[1], requestID, otherSubject, layer, publication, false); !errors.Is(err, helperaccess.ErrDeviceUnavailable) {
		t.Fatalf("another tenant with its own active share approved the pending code: %v", err)
	}
	if err := service.ApproveDevice(ctx, tenants[0], requestID, subject, layer, publication, false); err != nil {
		t.Fatal(err)
	}
	if _, err := service.LookupDevice(ctx, tenants[0], code.Code); !errors.Is(err, helperaccess.ErrDeviceUnavailable) {
		t.Fatalf("approval code can be read again: %v", err)
	}
	if err := service.ApproveDevice(ctx, tenants[0], requestID, subject, layer, publication, false); !errors.Is(err, helperaccess.ErrDeviceUnavailable) {
		t.Fatalf("approval replay succeeded: %v", err)
	}
	if err := service.ApproveDevice(ctx, tenants[0], requestID, subject, accountTenantIntegrationID(t), publication, true); !errors.Is(err, helperaccess.ErrDeviceUnavailable) {
		t.Fatalf("refresh switched the bound layer: %v", err)
	}
	resetPoll := func() {
		t.Helper()
		hash := sha256.Sum256([]byte(poll))
		if _, err := pool.Exec(ctx, "update helper_device_requests set next_poll_at = now() where poll_hash = $1", hash[:]); err != nil {
			t.Fatal(err)
		}
	}
	resetPoll()
	approved, err := service.PollDevice(ctx, poll)
	if err != nil || approved.Attachment == nil {
		t.Fatalf("approved device did not receive an attachment: %v", err)
	}
	if _, err := service.StartDevice(ctx, tenants[0], "Proof device", key, credential, secret(), true); err != nil {
		t.Fatalf("reuse durable registration: %v", err)
	}
	if err := service.RevokeDevice(ctx, tenants[1], requestID); err != nil {
		t.Fatal(err)
	}
	devices, err := service.ListDevices(ctx, tenants[0])
	if err != nil || len(devices) != 1 {
		t.Fatalf("another tenant revoked this device: %+v, %v", devices, err)
	}
	t.Run("revocation wins during the share check", func(t *testing.T) {
		paused := pausedHelperShare{started: make(chan struct{}), resume: make(chan struct{})}
		racing := helperaccess.NewService(paused, "test", "test", signer).WithDevices(store)
		resetPoll()
		result := make(chan error, 1)
		go func() {
			_, err := racing.PollDevice(ctx, poll)
			result <- err
		}()
		<-paused.started
		err := service.RevokeDevice(ctx, tenants[0], requestID)
		close(paused.resume)
		if err != nil {
			t.Fatal(err)
		}
		if err := <-result; !errors.Is(err, helperaccess.ErrDeviceUnavailable) {
			t.Fatalf("ticket was minted after revocation returned: %v", err)
		}
	})
	resetPoll()
	if _, err := service.PollDevice(ctx, poll); !errors.Is(err, helperaccess.ErrDeviceUnavailable) {
		t.Fatalf("revoked device renewed its ticket: %v", err)
	}
	if _, err := service.StartDevice(ctx, tenants[0], "Proof device", key, credential, secret(), true); !errors.Is(err, helperaccess.ErrDeviceUnavailable) {
		t.Fatalf("revoked registration began a new exchange: %v", err)
	}

	t.Run("remembered loopback keys are tenant scoped and revocable", func(t *testing.T) {
		binding := helperaccess.Binding{DeviceKey: key, PublicationID: publication, LayerID: layer}
		challenge := secret()
		check := func(subject accessgrants.Subject, want bool) {
			t.Helper()
			tickets, err := service.IssueLocal(ctx, subject, binding, "https://chalk.test", challenge, true)
			if err != nil || tickets.Remembered != want || tickets.Pair.Value == "" {
				t.Fatalf("remembered = %v, want %v, issue error %v", tickets.Remembered, want, err)
			}
		}
		check(subject, false)
		for range 2 {
			if err := service.RememberLoopbackDevice(ctx, subject.TenantID, key); err != nil {
				t.Fatal(err)
			}
		}
		check(subject, true)
		check(otherSubject, false)

		devices, err := service.ListDevices(ctx, subject.TenantID)
		if err != nil || len(devices) != 1 {
			t.Fatalf("expected one new revocable device: %v, error %v", len(devices), err)
		}
		device, err := utilities.ParseID(devices[0].ID)
		if err != nil {
			t.Fatal(err)
		}

		paused := pausedHelperShare{started: make(chan struct{}), resume: make(chan struct{})}
		racing := helperaccess.NewService(paused, "test", "test", signer).WithDevices(store)
		type result struct {
			tickets helperaccess.LocalTickets
			err     error
		}
		issued := make(chan result, 1)
		go func() {
			tickets, err := racing.IssueLocal(ctx, subject, binding, "https://chalk.test", challenge, true)
			issued <- result{tickets, err}
		}()
		<-paused.started
		err = service.RevokeDevice(ctx, subject.TenantID, device)
		close(paused.resume)
		if err != nil {
			t.Fatal(err)
		}
		if got := <-issued; got.err != nil || got.tickets.Remembered {
			t.Fatalf("a remembered ticket was issued after revoke returned: %v", got.err)
		}
		if err := service.RememberLoopbackDevice(ctx, subject.TenantID, key); err != nil {
			t.Fatal(err)
		}
		check(subject, false)
	})
}
