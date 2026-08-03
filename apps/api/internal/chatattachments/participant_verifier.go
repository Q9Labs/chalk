package chatattachments

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/synctokens"
)

type SyncParticipantVerifier interface {
	Verify(context.Context, string) (synctokens.Subject, error)
}

type ParticipantVerifier struct {
	verifier SyncParticipantVerifier
}

func NewParticipantVerifier(verifier SyncParticipantVerifier) ParticipantVerifier {
	return ParticipantVerifier{verifier: verifier}
}

func (v ParticipantVerifier) VerifyChatParticipant(ctx context.Context, credential string) (Subject, bool, error) {
	if v.verifier == nil {
		return Subject{}, false, nil
	}
	subject, err := v.verifier.Verify(ctx, credential)
	if err != nil {
		return Subject{}, false, nil
	}
	return Subject{
		TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID,
		ParticipantID:         subject.ParticipantID,
		ParticipantGeneration: subject.ParticipantGeneration,
	}, true, nil
}
