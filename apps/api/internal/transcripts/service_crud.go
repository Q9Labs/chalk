package transcripts

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (s Service) Create(ctx context.Context, input CreateInput) (Transcript, error) {
	id, err := utilities.NewID()
	if err != nil {
		return Transcript{}, err
	}
	input.ID = id
	if err := prepareCreateInput(&input); err != nil {
		return Transcript{}, err
	}

	return s.repository.Create(ctx, input)
}

func (s Service) Get(ctx context.Context, tenantID utilities.ID, transcriptID utilities.ID) (Transcript, error) {
	if tenantID.IsZero() {
		return Transcript{}, ErrInvalidTenantID
	}
	if transcriptID.IsZero() {
		return Transcript{}, ErrInvalidTranscriptID
	}

	return s.repository.Get(ctx, tenantID, transcriptID)
}

func (s Service) List(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID, page pagination.PageRequest) (TranscriptList, error) {
	if tenantID.IsZero() {
		return TranscriptList{}, ErrInvalidTenantID
	}

	return s.repository.List(ctx, tenantID, recordingID, page)
}

func (s Service) Update(ctx context.Context, tenantID utilities.ID, transcriptID utilities.ID, input UpdateInput) (Transcript, error) {
	if tenantID.IsZero() {
		return Transcript{}, ErrInvalidTenantID
	}
	if transcriptID.IsZero() {
		return Transcript{}, ErrInvalidTranscriptID
	}
	if err := prepareUpdateInput(&input); err != nil {
		return Transcript{}, err
	}

	return s.repository.Update(ctx, tenantID, transcriptID, input)
}
