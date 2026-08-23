package webhooks

import (
	"encoding/base64"
	"encoding/json"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestEventEncodersRejectImpossibleTransitions(t *testing.T) {
	metadata := fixtureMetadata(t, "00000000-0000-4000-8000-000000000012", "space.updated", "2026-07-12T18:01:00.000Z")
	if _, _, err := EncodeSpaceEvent(metadata, SpaceSnapshot{}, nil); err == nil {
		t.Fatal("space.updated without changed_fields accepted")
	}
	metadata.Name = "episode.ended"
	started := metadata.OccurredAt.Add(-time.Hour)
	if _, _, err := EncodeEpisodeEvent(metadata, EpisodeSnapshot{Status: "ended", StartedAt: &started}); err == nil {
		t.Fatal("episode.ended without ended_at accepted")
	}
	metadata.Name = "participant.left"
	if _, _, err := EncodeParticipantEvent(metadata, ParticipantSnapshot{Status: "left", JoinedAt: started}); err == nil {
		t.Fatal("participant.left without left_at accepted")
	}
}

func TestStandardWebhookSignatureMatchesGoldenVector(t *testing.T) {
	body, err := os.ReadFile("../../../../contract/webhooks/v1/signature-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		WebhookID        string `json:"webhook_id"`
		WebhookTimestamp string `json:"webhook_timestamp"`
		BodyUTF8         string `json:"body_utf8"`
		Secrets          []struct {
			Value     string
			Signature string
		}
	}
	if err := json.Unmarshal(body, &vector); err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(vector.Secrets[0].Value, "whsec_"))
	if err != nil {
		t.Fatal(err)
	}
	timestampSeconds, _ := strconv.ParseInt(vector.WebhookTimestamp, 10, 64)
	timestamp, signature := SignatureHeader(vector.WebhookID, time.Unix(timestampSeconds, 0), []byte(vector.BodyUTF8), raw)
	if timestamp != vector.WebhookTimestamp || signature != vector.Secrets[0].Signature {
		t.Fatalf("signature %q at %q", signature, timestamp)
	}
}

func TestEndpointURLAndAddressPolicy(t *testing.T) {
	normalized, redacted, err := ValidateEndpointURL("https://Hooks.Example.com/chalk?token=secret")
	if err != nil {
		t.Fatal(err)
	}
	if normalized != "https://hooks.example.com/chalk?token=secret" || redacted != "https://hooks.example.com/chalk?REDACTED" {
		t.Fatalf("normalized=%q redacted=%q", normalized, redacted)
	}
	for _, value := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1"} {
		if PublicAddress(netip.MustParseAddr(value)) {
			t.Fatalf("address %s allowed", value)
		}
	}
	for _, value := range []string{"1.1.1.1", "2606:4700:4700::1111"} {
		if !PublicAddress(netip.MustParseAddr(value)) {
			t.Fatalf("public address %s rejected", value)
		}
	}
}

func TestAESGCMProtectorAuthenticatesCiphertext(t *testing.T) {
	protector, err := NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, err := protector.Protect("tenant/endpoint/secret", []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := protector.Unprotect("tenant/endpoint/secret", ciphertext)
	if err != nil || string(plaintext) != "secret" {
		t.Fatalf("plaintext=%q err=%v", plaintext, err)
	}
	ciphertext[len(ciphertext)-1] ^= 1
	if _, err := protector.Unprotect("tenant/other/secret", ciphertext); err == nil {
		t.Fatal("tampered ciphertext accepted")
	}
}

func TestAESGCMKeyringDecryptsOldVersionsAndWritesCurrentVersion(t *testing.T) {
	oldKey := make([]byte, 32)
	newKey := make([]byte, 32)
	newKey[0] = 1
	oldProtector, err := NewAESGCMKeyring(1, map[byte][]byte{1: oldKey})
	if err != nil {
		t.Fatal(err)
	}
	oldCiphertext, err := oldProtector.Protect("scope", []byte("old secret"))
	if err != nil {
		t.Fatal(err)
	}
	rotatedProtector, err := NewAESGCMKeyring(2, map[byte][]byte{1: oldKey, 2: newKey})
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := rotatedProtector.Unprotect("scope", oldCiphertext)
	if err != nil || string(plaintext) != "old secret" {
		t.Fatalf("old plaintext = %q, error = %v", plaintext, err)
	}
	newCiphertext, err := rotatedProtector.Protect("scope", []byte("new secret"))
	if err != nil {
		t.Fatal(err)
	}
	if len(newCiphertext) < 2 || newCiphertext[1] != 2 {
		t.Fatalf("ciphertext key version = %v, want 2", newCiphertext)
	}
	if _, err := oldProtector.Unprotect("scope", newCiphertext); err == nil {
		t.Fatal("old-only keyring decrypted current-version ciphertext")
	}
}

func TestRetryScheduleStopsAtHorizon(t *testing.T) {
	occurred := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	deliveryID, err := utilities.ParseID("018bcfe5-6800-7000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	if next := NextAttemptAt(deliveryID, occurred, occurred.Add(48*time.Hour), 11, 0); next == nil || next.After(occurred.Add(72*time.Hour)) {
		t.Fatalf("next=%v", next)
	}
	if next := NextAttemptAt(deliveryID, occurred, occurred.Add(72*time.Hour), 12, 0); next != nil {
		t.Fatalf("unexpected next=%v", next)
	}
}

func TestWebhookMetricEventLabelsAreBounded(t *testing.T) {
	if got := boundedMetricEventName("endpoint.test"); got != "endpoint.test" {
		t.Fatalf("endpoint.test label = %q", got)
	}
	if got := boundedMetricEventName("customer.controlled"); got != "other" {
		t.Fatalf("unknown event label = %q", got)
	}
	if got := boundedMetricAPIVersion(APIVersion); got != APIVersion {
		t.Fatalf("api version label = %d", got)
	}
	if got := boundedMetricAPIVersion(999); got != 0 {
		t.Fatalf("unknown api version label = %d", got)
	}
}

func fixtureMetadata(t *testing.T, idValue, name, at string) EventMetadata {
	t.Helper()
	id, err := utilities.ParseID(idValue)
	if err != nil {
		t.Fatal(err)
	}
	tenantID, err := utilities.ParseID("10000000-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	return EventMetadata{ID: id, TenantID: tenantID, Name: name, OccurredAt: mustTime(t, at)}
}

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
