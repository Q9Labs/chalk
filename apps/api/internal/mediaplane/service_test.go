package mediaplane

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestServiceEnsureSessionValidatesAndDelegates(t *testing.T) {
	plane := &planeStub{
		session: Session{Provider: ProviderCloudflareRTK, Ref: "meeting_123"},
	}
	service := NewService(plane)

	session, err := service.EnsureSession(context.Background(), EnsureSessionInput{
		Provider:   ProviderCloudflareRTK,
		SessionKey: " session_123 ",
		Title:      " Weekly sync ",
	})
	if err != nil {
		t.Fatalf("ensure session: %v", err)
	}

	if session.Ref != "meeting_123" {
		t.Fatalf("session ref = %q, want meeting_123", session.Ref)
	}
	if plane.ensureInput.SessionKey != "session_123" {
		t.Fatalf("session key = %q, want trimmed value", plane.ensureInput.SessionKey)
	}
	if plane.ensureInput.Title != "Weekly sync" {
		t.Fatalf("title = %q, want trimmed value", plane.ensureInput.Title)
	}
}

func TestServiceCreateJoinValidatesAndDelegates(t *testing.T) {
	expiresAt := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	plane := &planeStub{
		join: Join{
			Provider:       ProviderCloudflareRTK,
			ParticipantRef: "participant_123",
			ExpiresAt:      expiresAt,
		},
	}
	service := NewService(plane)

	join, err := service.CreateJoin(context.Background(), CreateJoinInput{
		Provider: ProviderCloudflareRTK,
		Session: Session{
			Provider: ProviderCloudflareRTK,
			Ref:      " meeting_123 ",
		},
		ParticipantName:       " Ada ",
		ExternalParticipantID: " user_123 ",
		ParticipantPreset:     " facilitator ",
	})
	if err != nil {
		t.Fatalf("create join: %v", err)
	}

	if join.ParticipantRef != "participant_123" {
		t.Fatalf("participant ref = %q, want participant_123", join.ParticipantRef)
	}
	if plane.joinInput.Session.Ref != "meeting_123" {
		t.Fatalf("session ref = %q, want trimmed value", plane.joinInput.Session.Ref)
	}
	if plane.joinInput.ParticipantName != "Ada" {
		t.Fatalf("participant name = %q, want trimmed value", plane.joinInput.ParticipantName)
	}
	if plane.joinInput.ExternalParticipantID != "user_123" {
		t.Fatalf("external participant id = %q, want trimmed value", plane.joinInput.ExternalParticipantID)
	}
	if plane.joinInput.ParticipantPreset != "facilitator" {
		t.Fatalf("participant preset = %q, want trimmed value", plane.joinInput.ParticipantPreset)
	}
}

func TestServiceRejectsInvalidInputs(t *testing.T) {
	service := NewService(&planeStub{})
	tests := []struct {
		name string
		run  func() error
		want error
	}{
		{
			name: "ensure invalid provider",
			run: func() error {
				_, err := service.EnsureSession(context.Background(), EnsureSessionInput{Provider: "other", SessionKey: "session_123"})
				return err
			},
			want: ErrInvalidProvider,
		},
		{
			name: "ensure blank session key",
			run: func() error {
				_, err := service.EnsureSession(context.Background(), EnsureSessionInput{Provider: ProviderCloudflareRTK})
				return err
			},
			want: ErrInvalidSessionKey,
		},
		{
			name: "join mismatched provider",
			run: func() error {
				_, err := service.CreateJoin(context.Background(), CreateJoinInput{
					Provider: ProviderCloudflareRTK,
					Session:  Session{Provider: ProviderCloudflareSFU, Ref: "session_123"},
				})
				return err
			},
			want: ErrInvalidProvider,
		},
		{
			name: "join missing participant",
			run: func() error {
				_, err := service.CreateJoin(context.Background(), CreateJoinInput{
					Provider:          ProviderCloudflareRTK,
					Session:           Session{Provider: ProviderCloudflareRTK, Ref: "session_123"},
					ParticipantPreset: "contributor",
				})
				return err
			},
			want: ErrInvalidParticipantName,
		},
		{
			name: "join missing preset",
			run: func() error {
				_, err := service.CreateJoin(context.Background(), CreateJoinInput{
					Provider:        ProviderCloudflareRTK,
					Session:         Session{Provider: ProviderCloudflareRTK, Ref: "session_123"},
					ParticipantName: "Ada",
				})
				return err
			},
			want: ErrInvalidParticipantPreset,
		},
		{
			name: "remove missing participant ref",
			run: func() error {
				return service.RemoveParticipant(context.Background(), RemoveParticipantInput{
					Provider:   ProviderCloudflareRTK,
					SessionRef: "session_123",
				})
			},
			want: ErrInvalidParticipantRef,
		},
		{
			name: "end missing session ref",
			run: func() error {
				return service.EndSession(context.Background(), EndSessionInput{Provider: ProviderCloudflareRTK})
			},
			want: ErrInvalidSessionRef,
		},
		{
			name: "usage missing session ref",
			run: func() error {
				_, err := service.SessionUsage(context.Background(), SessionUsageInput{Provider: ProviderCloudflareRTK})
				return err
			},
			want: ErrInvalidSessionRef,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.run(); !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestServiceRejectsMissingPlane(t *testing.T) {
	service := NewService(nil)

	_, err := service.EnsureSession(context.Background(), EnsureSessionInput{
		Provider:   ProviderCloudflareRTK,
		SessionKey: "session_123",
	})
	if !errors.Is(err, ErrPlaneUnavailable) {
		t.Fatalf("error = %v, want %v", err, ErrPlaneUnavailable)
	}
}

type planeStub struct {
	ensureInput EnsureSessionInput
	joinInput   CreateJoinInput
	session     Session
	join        Join
}

func (p *planeStub) EnsureSession(_ context.Context, input EnsureSessionInput) (Session, error) {
	p.ensureInput = input
	return p.session, nil
}

func (p *planeStub) CreateJoin(_ context.Context, input CreateJoinInput) (Join, error) {
	p.joinInput = input
	return p.join, nil
}

func (p *planeStub) RemoveParticipant(context.Context, RemoveParticipantInput) error {
	return nil
}

func (p *planeStub) EndSession(context.Context, EndSessionInput) error {
	return nil
}

func (p *planeStub) SessionUsage(context.Context, SessionUsageInput) (Usage, error) {
	return Usage{}, nil
}
