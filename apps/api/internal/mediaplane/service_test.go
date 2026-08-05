package mediaplane

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestServiceEnsureEpisodeValidatesAndDelegates(t *testing.T) {
	plane := &planeStub{
		episode: Episode{Provider: ProviderCloudflareRTK, Ref: "episode_123"},
	}
	service := NewService(plane)

	episode, err := service.EnsureEpisode(context.Background(), EnsureEpisodeInput{
		Provider:   ProviderCloudflareRTK,
		EpisodeKey: " episode_123 ",
		Title:      " Weekly sync ",
	})
	if err != nil {
		t.Fatalf("ensure episode: %v", err)
	}

	if episode.Ref != "episode_123" {
		t.Fatalf("episode ref = %q, want episode_123", episode.Ref)
	}
	if plane.ensureInput.EpisodeKey != "episode_123" {
		t.Fatalf("episode key = %q, want trimmed value", plane.ensureInput.EpisodeKey)
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
		Episode: Episode{
			Provider: ProviderCloudflareRTK,
			Ref:      " episode_123 ",
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
	if plane.joinInput.Episode.Ref != "episode_123" {
		t.Fatalf("episode ref = %q, want trimmed value", plane.joinInput.Episode.Ref)
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

func TestServiceResumeJoinValidatesAndDelegates(t *testing.T) {
	plane := &resumePlaneStub{
		planeStub: planeStub{},
		join: Join{
			Provider:       ProviderCloudflareSFU,
			ParticipantRef: "participant_123",
			ClientPayload:  map[string]any{"connectionId": "connection_123"},
		},
	}
	service := NewServiceForProvider(ProviderCloudflareSFU, plane)

	join, err := service.ResumeJoin(context.Background(), ResumeJoinInput{
		Provider: ProviderCloudflareSFU,
		Episode: Episode{
			Provider: ProviderCloudflareSFU,
			Ref:      " episode_123 ",
		},
		ExternalParticipantID: " participant_123 ",
		ConnectionRef:         " connection_123 ",
	})
	if err != nil {
		t.Fatalf("resume join: %v", err)
	}
	if join.ParticipantRef != "participant_123" {
		t.Fatalf("participant ref = %q, want participant_123", join.ParticipantRef)
	}
	if plane.resumeInput.Episode.Ref != "episode_123" || plane.resumeInput.ExternalParticipantID != "participant_123" || plane.resumeInput.ConnectionRef != "connection_123" {
		t.Fatalf("resume input = %#v, want trimmed exact refs", plane.resumeInput)
	}
}

func TestServiceResumeJoinRejectsInvalidInputAndUnsupportedPlane(t *testing.T) {
	tests := []struct {
		name  string
		input ResumeJoinInput
		want  error
	}{
		{
			name: "provider mismatch",
			input: ResumeJoinInput{
				Provider:              ProviderCloudflareRTK,
				Episode:               Episode{Provider: ProviderCloudflareRTK, Ref: "episode_123"},
				ExternalParticipantID: "participant_123",
				ConnectionRef:         "connection_123",
			},
			want: ErrInvalidProvider,
		},
		{
			name: "episode provider mismatch",
			input: ResumeJoinInput{
				Provider:              ProviderCloudflareSFU,
				Episode:               Episode{Provider: ProviderCloudflareRTK, Ref: "episode_123"},
				ExternalParticipantID: "participant_123",
				ConnectionRef:         "connection_123",
			},
			want: ErrInvalidProvider,
		},
		{
			name: "missing episode",
			input: ResumeJoinInput{
				Provider:              ProviderCloudflareSFU,
				Episode:               Episode{Provider: ProviderCloudflareSFU},
				ExternalParticipantID: "participant_123",
				ConnectionRef:         "connection_123",
			},
			want: ErrInvalidEpisodeRef,
		},
		{
			name: "missing participant",
			input: ResumeJoinInput{
				Provider:      ProviderCloudflareSFU,
				Episode:       Episode{Provider: ProviderCloudflareSFU, Ref: "episode_123"},
				ConnectionRef: "connection_123",
			},
			want: ErrInvalidParticipantRef,
		},
		{
			name: "missing connection",
			input: ResumeJoinInput{
				Provider:              ProviderCloudflareSFU,
				Episode:               Episode{Provider: ProviderCloudflareSFU, Ref: "episode_123"},
				ExternalParticipantID: "participant_123",
			},
			want: ErrInvalidConnectionRef,
		},
	}

	service := NewServiceForProvider(ProviderCloudflareSFU, &resumePlaneStub{})
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := service.ResumeJoin(context.Background(), tt.input)
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}

	unsupported := NewServiceForProvider(ProviderCloudflareSFU, &planeStub{})
	_, err := unsupported.ResumeJoin(context.Background(), ResumeJoinInput{})
	if !errors.Is(err, ErrUnsupportedOperation) {
		t.Fatalf("unsupported error = %v, want %v", err, ErrUnsupportedOperation)
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
				_, err := service.EnsureEpisode(context.Background(), EnsureEpisodeInput{Provider: "other", EpisodeKey: "episode_123"})
				return err
			},
			want: ErrInvalidProvider,
		},
		{
			name: "ensure blank episode key",
			run: func() error {
				_, err := service.EnsureEpisode(context.Background(), EnsureEpisodeInput{Provider: ProviderCloudflareRTK})
				return err
			},
			want: ErrInvalidEpisodeKey,
		},
		{
			name: "join mismatched provider",
			run: func() error {
				_, err := service.CreateJoin(context.Background(), CreateJoinInput{
					Provider: ProviderCloudflareRTK,
					Episode:  Episode{Provider: ProviderCloudflareSFU, Ref: "episode_123"},
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
					Episode:           Episode{Provider: ProviderCloudflareRTK, Ref: "episode_123"},
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
					Episode:         Episode{Provider: ProviderCloudflareRTK, Ref: "episode_123"},
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
					EpisodeRef: "episode_123",
				})
			},
			want: ErrInvalidParticipantRef,
		},
		{
			name: "end missing episode ref",
			run: func() error {
				return service.EndEpisode(context.Background(), EndEpisodeInput{Provider: ProviderCloudflareRTK})
			},
			want: ErrInvalidEpisodeRef,
		},
		{
			name: "usage missing episode ref",
			run: func() error {
				_, err := service.EpisodeUsage(context.Background(), EpisodeUsageInput{Provider: ProviderCloudflareRTK})
				return err
			},
			want: ErrInvalidEpisodeRef,
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

	_, err := service.EnsureEpisode(context.Background(), EnsureEpisodeInput{
		Provider:   ProviderCloudflareRTK,
		EpisodeKey: "episode_123",
	})
	if !errors.Is(err, ErrPlaneUnavailable) {
		t.Fatalf("error = %v, want %v", err, ErrPlaneUnavailable)
	}
}

type planeStub struct {
	ensureInput EnsureEpisodeInput
	joinInput   CreateJoinInput
	episode     Episode
	join        Join
}

type resumePlaneStub struct {
	planeStub
	resumeInput ResumeJoinInput
	join        Join
}

func (p *resumePlaneStub) ResumeJoin(_ context.Context, input ResumeJoinInput) (Join, error) {
	p.resumeInput = input
	return p.join, nil
}

func (p *planeStub) EnsureEpisode(_ context.Context, input EnsureEpisodeInput) (Episode, error) {
	p.ensureInput = input
	return p.episode, nil
}

func (p *planeStub) CreateJoin(_ context.Context, input CreateJoinInput) (Join, error) {
	p.joinInput = input
	return p.join, nil
}

func (p *planeStub) RemoveParticipant(context.Context, RemoveParticipantInput) error {
	return nil
}

func (p *planeStub) EndEpisode(context.Context, EndEpisodeInput) error {
	return nil
}

func (p *planeStub) EpisodeUsage(context.Context, EpisodeUsageInput) (Usage, error) {
	return Usage{}, nil
}
