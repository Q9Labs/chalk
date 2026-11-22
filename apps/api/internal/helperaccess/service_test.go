package helperaccess

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingRepository struct {
	subject     accessgrants.Subject
	layer       utilities.ID
	publication string
	current     bool
}

func (r *recordingRepository) CurrentAnnotationShare(_ context.Context, subject accessgrants.Subject, layer utilities.ID, publication string) (bool, error) {
	return r.current && subject == r.subject && layer == r.layer && publication == r.publication, nil
}

func TestIssueLocalRequiresCurrentShareAndSignsSeparateAudiences(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := func(value string) utilities.ID {
		parsed, err := utilities.ParseID("55555555-5555-4555-8555-" + value)
		if err != nil {
			t.Fatal(err)
		}
		return parsed
	}
	subject := accessgrants.Subject{
		TenantID: id("100000000001"), SpaceID: id("100000000002"), EpisodeID: id("100000000003"), ParticipantID: id("100000000004"),
		ParticipantGeneration: 3, ConnectionID: "test-connection",
	}
	publication := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"test-connection","m":"0","t":"screen","g":3}`))
	binding := Binding{LayerID: id("100000000005"), PublicationID: publication, DeviceKey: base64.RawURLEncoding.EncodeToString(public)}
	repository := &recordingRepository{subject: subject, publication: publication, layer: binding.LayerID, current: true}
	annotationEnabled := false
	service := NewService(repository, "test-issuer", "test-key", private).
		WithAnnotationAvailability(func(context.Context) bool { return annotationEnabled })
	now := time.Date(2026, 11, 21, 15, 0, 0, 750_000_000, time.UTC)
	service.now = func() time.Time { return now }
	challenge := base64.RawURLEncoding.EncodeToString(make([]byte, 32))

	if _, err := service.IssueLocal(t.Context(), subject, binding, "https://chalk.test", challenge, false); !errors.Is(err, ErrAnnotationDisabled) {
		t.Fatalf("disabled annotation issued a Helper ticket: %v", err)
	}
	annotationEnabled = true
	tickets, err := service.IssueLocal(t.Context(), subject, binding, "https://chalk.test", challenge, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, ticket := range []struct {
		token    Ticket
		audience string
	}{
		{tickets.Pair, localAudience},
		{tickets.Attachment, remoteAudience},
	} {
		parts := strings.Split(ticket.token.Value, ".")
		if len(parts) != 3 {
			t.Fatal("invalid compact ticket")
		}
		input := parts[0] + "." + parts[1]
		signature, _ := base64.RawURLEncoding.DecodeString(parts[2])
		if !ed25519.Verify(public, []byte(input), signature) {
			t.Fatal("invalid ticket signature")
		}
		claims := map[string]any{}
		payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
		if err := json.Unmarshal(payload, &claims); err != nil || claims["aud"] != ticket.audience {
			t.Fatalf("claims %#v, error %v", claims, err)
		}
	}
	if tickets.Pair.ExpiresAtMs != now.Add(lifetime).UnixMilli() ||
		tickets.Attachment.ExpiresAtMs != now.Truncate(time.Second).Add(lifetime).UnixMilli() {
		t.Fatal("ticket exceeds its lease")
	}
	for name, graft := range map[string]accessgrants.Subject{
		"tenant graft":    {TenantID: id("100000000008"), SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, ParticipantGeneration: 3, ConnectionID: subject.ConnectionID},
		"stale actor":     {TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, ParticipantGeneration: 2, ConnectionID: subject.ConnectionID},
		"connection swap": {TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, ParticipantGeneration: 3, ConnectionID: "retired-connection"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := service.IssueLocal(t.Context(), graft, binding, "https://chalk.test", challenge, false)
			if !errors.Is(err, ErrShareNotCurrent) {
				t.Fatalf("got %v", err)
			}
		})
	}
	repository.current = false
	if _, err := service.IssueLocal(t.Context(), subject, binding, "https://chalk.test", challenge, false); !errors.Is(err, ErrShareNotCurrent) {
		t.Fatalf("refresh of a closed share: %v", err)
	}
}
