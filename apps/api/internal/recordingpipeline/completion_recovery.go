package recordingpipeline

import (
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrCompletionRecoveryUnavailable      = errors.New("recording completion recovery unavailable")
	ErrCompletionRecoveryAlreadyRequested = errors.New("recording completion recovery already requested")
)

type CompletionRecoveryInput struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
	RequestID   utilities.ID
	Operator    string
	Reason      string
}

type CompletionRecoveryObjects interface {
	InspectObject(context.Context, string) (objectstorage.ObjectFacts, error)
}
