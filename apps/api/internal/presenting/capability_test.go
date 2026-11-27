package presenting

import (
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func capabilityTestJob(t *testing.T) RenderJob {
	t.Helper()
	id := func(value string) utilities.ID {
		id, err := utilities.ParseID(value)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	return RenderJob{Kind: "pages", PageStart: 2, PageEnd: 25, RenderLease: RenderLease{TenantID: id("12345678-1234-4234-8234-123456789abc"), SpaceID: id("22345678-1234-4234-8234-123456789abc"), DocumentID: id("32345678-1234-4234-8234-123456789abc"), JobID: id("42345678-1234-4234-8234-123456789abc"), Attempt: 1}}
}

func TestRenderCapabilityRoundTripAndBinding(t *testing.T) {
	signer, err := NewCapabilitySigner("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	job := capabilityTestJob(t)
	token, err := signer.Issue(job)
	if err != nil {
		t.Fatal(err)
	}
	capability, err := signer.Verify(token)
	if err != nil {
		t.Fatal(err)
	}
	if capability.JobID != job.JobID || capability.Attempt != 2 || capability.Kind != "pages" || capability.PageStart != 2 || capability.PageEnd != 25 {
		t.Fatalf("capability binding mismatch: %+v", capability)
	}
	if time.Until(capability.ExpiresAt) > RenderCapabilityLifetime+time.Second {
		t.Fatal("capability lifetime exceeded its bound")
	}
	lease := job.RenderLease
	lease.Attempt = 2
	if !capability.MatchesLease(lease) {
		t.Fatal("capability does not match its issued lease")
	}
	lease.Attempt = 1
	if capability.MatchesLease(lease) {
		t.Fatal("capability matched a different attempt")
	}
	other, _ := NewCapabilitySigner("another-secret-key-with-at-least-32-bytes")
	if _, err := other.Verify(token); err == nil {
		t.Fatal("capability verified with the wrong signing key")
	}
	parts := strings.Split(token, ".")
	parts[1] = parts[1][:len(parts[1])-1] + "A"
	if _, err := signer.Verify(strings.Join(parts, ".")); err == nil {
		t.Fatal("tampered capability verified")
	}
}

func TestRenderCapabilityRejectsMalformedJobShape(t *testing.T) {
	signer, _ := NewCapabilitySigner("01234567890123456789012345678901")
	job := capabilityTestJob(t)
	job.Kind = "inventory"
	if _, err := signer.Issue(job); err == nil {
		t.Fatal("inventory capability covered more than page one")
	}
}
