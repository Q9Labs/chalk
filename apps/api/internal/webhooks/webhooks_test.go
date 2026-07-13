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

func TestRoomUpdatedEncoderMatchesGoldenBytes(t *testing.T) {
	metadata := fixtureMetadata(t, "00000000-0000-4000-8000-000000000002", "room.updated", "2026-07-12T18:01:00.000Z")
	body, _, err := EncodeRoomEvent(metadata, RoomSnapshot{ID: "20000000-0000-4000-8000-000000000001", Name: "Design review – 東京", Slug: "weekly-design-review", Status: "active", MediaPlane: "cf_rtk", CreatedAt: mustTime(t, "2026-07-01T08:00:00.000Z"), UpdatedAt: mustTime(t, "2026-07-12T18:01:00.000Z")}, []string{"name", "metadata"})
	if err != nil {
		t.Fatal(err)
	}
	expected := `{"id":"00000000-0000-4000-8000-000000000002","event":"room.updated","api_version":1,"occurred_at":"2026-07-12T18:01:00.000Z","tenant_id":"10000000-0000-4000-8000-000000000001","data":{"object":{"id":"20000000-0000-4000-8000-000000000001","name":"Design review – 東京","slug":"weekly-design-review","status":"active","media_plane":"cf_rtk","created_at":"2026-07-01T08:00:00.000Z","updated_at":"2026-07-12T18:01:00.000Z"},"changed_fields":["metadata","name"]}}`
	if string(body) != expected {
		t.Fatalf("body mismatch\nwant %s\n got %s", expected, body)
	}
}

func TestEventEncoderUsesCrossRuntimeStringEscaping(t *testing.T) {
	metadata := fixtureMetadata(t, "00000000-0000-4000-8000-000000000012", "room.created", "2026-07-12T18:01:00.000Z")
	body, _, err := EncodeRoomEvent(metadata, RoomSnapshot{ID: "20000000-0000-4000-8000-000000000001", Name: "<tag>& \\\"quote\\\" \\\\ tab\t newline\n", Slug: "hostile", Status: "active", MediaPlane: "cf_rtk", CreatedAt: metadata.OccurredAt, UpdatedAt: metadata.OccurredAt}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := `"name":"<tag>& \\\"quote\\\" \\\\ tab\t newline\n"`; !strings.Contains(string(body), want) {
		t.Fatalf("hostile string encoding mismatch: %s", body)
	}
	if strings.Contains(string(body), `\u003c`) || strings.Contains(string(body), `\u0026`) {
		t.Fatalf("HTML escaping is not canonical: %s", body)
	}
}

func TestEventEncodersRejectImpossibleTransitions(t *testing.T) {
	metadata := fixtureMetadata(t, "00000000-0000-4000-8000-000000000012", "room.updated", "2026-07-12T18:01:00.000Z")
	if _, _, err := EncodeRoomEvent(metadata, RoomSnapshot{Status: "active"}, nil); err == nil {
		t.Fatal("room.updated without changed_fields accepted")
	}
	metadata.Name = "session.ended"
	started := metadata.OccurredAt.Add(-time.Hour)
	if _, _, err := EncodeSessionEvent(metadata, SessionSnapshot{Status: "ended", StartedAt: &started}); err == nil {
		t.Fatal("session.ended without ended_at accepted")
	}
	metadata.Name = "participant.left"
	if _, _, err := EncodeParticipantEvent(metadata, ParticipantSnapshot{Status: "left", JoinedAt: started}); err == nil {
		t.Fatal("participant.left without left_at accepted")
	}
}

func TestRoomEncoderAcceptsArchivedCreationAndDoesNotMutateChangedFields(t *testing.T) {
	t.Parallel()
	metadata := fixtureMetadata(t, "00000000-0000-4000-8000-000000000012", "room.created", "2026-07-12T18:01:00.000Z")
	snapshot := RoomSnapshot{ID: "20000000-0000-4000-8000-000000000001", Name: "Archived import", Slug: "archived-import", Status: "archived", MediaPlane: "cf_rtk", CreatedAt: metadata.OccurredAt, UpdatedAt: metadata.OccurredAt}
	if _, _, err := EncodeRoomEvent(metadata, snapshot, nil); err != nil {
		t.Fatalf("archived room.created rejected: %v", err)
	}
	if _, _, err := EncodeRoomEvent(metadata, snapshot, []string{"name"}); err == nil {
		t.Fatal("room.created accepted changed_fields")
	}
	metadata.Name = "room.updated"
	snapshot.Status = "active"
	fields := []string{"slug", "name"}
	if _, _, err := EncodeRoomEvent(metadata, snapshot, fields); err != nil {
		t.Fatal(err)
	}
	if fields[0] != "slug" || fields[1] != "name" {
		t.Fatalf("caller changed_fields mutated: %#v", fields)
	}
}

func TestEventEncodersRejectNonCanonicalIDsAndZeroPointerTimestamps(t *testing.T) {
	t.Parallel()
	metadata := fixtureMetadata(t, "00000000-0000-4000-8000-000000000012", "session.started", "2026-07-12T18:01:00.000Z")
	zero := time.Time{}
	created := metadata.OccurredAt
	tests := []struct {
		name string
		run  func() error
	}{
		{
			name: "uppercase snapshot uuid",
			run: func() error {
				_, _, err := EncodeSessionEvent(metadata, SessionSnapshot{ID: "20000000-0000-4000-8000-00000000000A", RoomID: "30000000-0000-4000-8000-000000000001", Status: "active", StartedAt: &created, CreatedAt: created, UpdatedAt: created})
				return err
			},
		},
		{
			name: "zero session started_at",
			run: func() error {
				_, _, err := EncodeSessionEvent(metadata, SessionSnapshot{ID: "20000000-0000-4000-8000-000000000001", RoomID: "30000000-0000-4000-8000-000000000001", Status: "active", StartedAt: &zero, CreatedAt: created, UpdatedAt: created})
				return err
			},
		},
		{
			name: "zero participant left_at",
			run: func() error {
				leftMetadata := metadata
				leftMetadata.Name = "participant.left"
				_, _, err := EncodeParticipantEvent(leftMetadata, ParticipantSnapshot{ID: "20000000-0000-4000-8000-000000000001", RoomID: "30000000-0000-4000-8000-000000000001", SessionID: "40000000-0000-4000-8000-000000000001", Status: "left", JoinedAt: created, LeftAt: &zero})
				return err
			},
		},
		{
			name: "zero artifact completed_at",
			run: func() error {
				artifactMetadata := metadata
				artifactMetadata.Name = "recording.completed"
				_, _, err := EncodeRecordingEvent(artifactMetadata, RecordingSnapshot{ID: "20000000-0000-4000-8000-000000000001", RoomID: "30000000-0000-4000-8000-000000000001", SessionID: "40000000-0000-4000-8000-000000000001", Status: "completed", StartedAt: &created, CompletedAt: &zero, CreatedAt: created, UpdatedAt: created})
				return err
			},
		},
		{
			name: "zero endpoint id",
			run: func() error {
				_, _, err := EncodeTestEvent(metadata, utilities.ID{})
				return err
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.run(); err == nil {
				t.Fatal("invalid payload accepted")
			}
		})
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
		Secrets          []struct{ Value, Signature string }
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

func TestParticipantEncoderMatchesHostileGoldenBytes(t *testing.T) {
	body, err := os.ReadFile("../../../../contract/webhooks/v1/signature-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		BodyUTF8 string `json:"body_utf8"`
	}
	if err := json.Unmarshal(body, &vector); err != nil {
		t.Fatal(err)
	}
	metadata := fixtureMetadata(t, "00000000-0000-4000-8000-000000000007", "participant.joined", "2026-07-12T18:05:00.000Z")
	userID := "50000000-0000-4000-8000-000000000001"
	name := `Ada – <&> "東京" \`
	encoded, _, err := EncodeParticipantEvent(metadata, ParticipantSnapshot{ID: "40000000-0000-4000-8000-000000000001", UserID: &userID, RoomID: "20000000-0000-4000-8000-000000000001", SessionID: "30000000-0000-4000-8000-000000000001", Name: &name, Status: "active", JoinedAt: mustTime(t, "2026-07-12T18:05:00.000Z")})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != vector.BodyUTF8 {
		t.Fatalf("body mismatch\nwant %s\n got %s", vector.BodyUTF8, encoded)
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
	for _, value := range []string{
		"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.88.99.1",
		"::192.0.2.1", "64:ff9b::1", "64:ff9b:1::1", "100::1", "100:0:0:1::1", "2001::1",
		"2001:20::1", "2001:db8::1", "2002:c000:0204::1", "3fff::1", "4000::1", "5f00::1",
		"fec0::1", "fe80::1", "::1",
	} {
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

func TestURLCiphertextCannotMoveBetweenTargetRevisions(t *testing.T) {
	protector, _ := NewAESGCMProtector(make([]byte, 32))
	tenantID, _ := utilities.ParseID("10000000-0000-4000-8000-000000000001")
	endpointID, _ := utilities.ParseID("20000000-0000-4000-8000-000000000001")
	firstRevision, _ := utilities.ParseID("30000000-0000-4000-8000-000000000001")
	secondRevision, _ := utilities.ParseID("30000000-0000-4000-8000-000000000002")
	ciphertext, err := protector.Protect(URLScope(tenantID, endpointID, firstRevision), []byte("https://example.com/hook"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := protector.Unprotect(URLScope(tenantID, endpointID, secondRevision), ciphertext); err == nil {
		t.Fatal("cross-revision URL ciphertext substitution succeeded")
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

func TestAESGCMKeyringRejectsNon256BitAndZeroVersionKeys(t *testing.T) {
	t.Parallel()
	for name, keys := range map[string]map[byte][]byte{
		"128-bit":      {1: make([]byte, 16)},
		"192-bit":      {1: make([]byte, 24)},
		"zero-version": {0: make([]byte, 32), 1: make([]byte, 32)},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewAESGCMKeyring(1, keys); err == nil {
				t.Fatal("keyring accepted invalid key")
			}
		})
	}
}

func TestRetryScheduleStopsAtHorizon(t *testing.T) {
	occurred := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	finished := occurred.Add(48 * time.Hour)
	deliveryID, err := utilities.ParseID("018bcfe5-6800-7000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	if next := NextAttemptAt(deliveryID, occurred, finished, 11, 0); next == nil || next.After(occurred.Add(72*time.Hour)) {
		t.Fatalf("next=%v", next)
	}
	if next := NextAttemptAt(deliveryID, occurred, occurred.Add(72*time.Hour), 12, 0); next != nil {
		t.Fatalf("unexpected next=%v", next)
	}
}

func TestRetryScheduleUsesStablePerDeliveryJitter(t *testing.T) {
	occurred := time.Unix(1700000000, 0)
	finished := occurred.Add(time.Second)
	first, _ := utilities.ParseID("018bcfe5-6800-7000-8000-000000000001")
	second, _ := utilities.ParseID("018bcfe5-6800-7000-8000-000000000002")
	a := NextAttemptAt(first, occurred, finished, 6, 0)
	b := NextAttemptAt(second, occurred, finished, 6, 0)
	again := NextAttemptAt(first, occurred, finished, 6, 0)
	if a == nil || b == nil || again == nil {
		t.Fatal("expected retry deadlines")
	}
	offset := retryOffsets[5]
	lower, upper := occurred.Add(offset-offset/10), occurred.Add(offset)
	for _, got := range []*time.Time{a, b} {
		if got.Before(lower) || got.After(upper) {
			t.Fatalf("retry %v outside [%v, %v]", got, lower, upper)
		}
	}
	if !a.Equal(*again) {
		t.Fatalf("jitter changed between calculations: %v != %v", a, again)
	}
	if a.Equal(*b) {
		t.Fatalf("distinct deliveries retried in lockstep at %v", a)
	}
}

func TestWebhookMetricEventLabelsAreBounded(t *testing.T) {
	t.Parallel()
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
