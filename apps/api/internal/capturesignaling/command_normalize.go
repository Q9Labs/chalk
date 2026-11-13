package capturesignaling

import (
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func (p CommandInput) count() int {
	count := 0
	if p.CreateCaptureConnection != nil {
		count++
	}
	if p.PullCaptureTracks != nil {
		count++
	}
	if p.RenegotiateCaptureConnection != nil {
		count++
	}
	if p.InspectCaptureConnection != nil {
		count++
	}
	if p.CloseCaptureTracks != nil {
		count++
	}
	if p.CloseCaptureConnection != nil {
		count++
	}
	return count
}

func (p CommandInput) operation() (captureplane.OperationKind, error) {
	if p.count() != 1 {
		return "", fmt.Errorf("%w: exactly one typed input is required", ErrInvalidCommand)
	}
	switch {
	case p.CreateCaptureConnection != nil:
		return captureplane.OperationCreateCaptureConnection, nil
	case p.PullCaptureTracks != nil:
		return captureplane.OperationPullCaptureTracks, nil
	case p.RenegotiateCaptureConnection != nil:
		return captureplane.OperationRenegotiateCaptureConnection, nil
	case p.InspectCaptureConnection != nil:
		return captureplane.OperationInspectCaptureConnection, nil
	case p.CloseCaptureTracks != nil:
		return captureplane.OperationCloseCaptureTracks, nil
	case p.CloseCaptureConnection != nil:
		return captureplane.OperationCloseCaptureConnection, nil
	default:
		return "", fmt.Errorf("%w: input is missing", ErrInvalidCommand)
	}
}

func (p CommandResult) count() int {
	count := 0
	if p.CreateCaptureConnection != nil {
		count++
	}
	if p.PullCaptureTracks != nil {
		count++
	}
	if p.RenegotiateCaptureConnection != nil {
		count++
	}
	if p.InspectCaptureConnection != nil {
		count++
	}
	if p.CloseCaptureTracks != nil {
		count++
	}
	if p.CloseCaptureConnection != nil {
		count++
	}
	return count
}

func (p CommandResult) operation() (captureplane.OperationKind, error) {
	if p.count() != 1 {
		return "", fmt.Errorf("%w: exactly one typed result is required", ErrCorruptStoredResult)
	}
	switch {
	case p.CreateCaptureConnection != nil:
		return captureplane.OperationCreateCaptureConnection, nil
	case p.PullCaptureTracks != nil:
		return captureplane.OperationPullCaptureTracks, nil
	case p.RenegotiateCaptureConnection != nil:
		return captureplane.OperationRenegotiateCaptureConnection, nil
	case p.InspectCaptureConnection != nil:
		return captureplane.OperationInspectCaptureConnection, nil
	case p.CloseCaptureTracks != nil:
		return captureplane.OperationCloseCaptureTracks, nil
	case p.CloseCaptureConnection != nil:
		return captureplane.OperationCloseCaptureConnection, nil
	default:
		return "", fmt.Errorf("%w: result is missing", ErrCorruptStoredResult)
	}
}

func normalizeInput(input CommandInput, operation captureplane.OperationKind, metadata captureplane.OperationMetadata) (CommandInput, error) {
	checkMetadata := func(actual captureplane.OperationMetadata) error {
		if metadataZero(actual) {
			return nil
		}
		if actual != metadata {
			return fmt.Errorf("%w: input metadata conflicts with command authority", ErrInvalidCommand)
		}
		return nil
	}
	switch operation {
	case captureplane.OperationCreateCaptureConnection:
		value := *input.CreateCaptureConnection
		if err := checkMetadata(value.Metadata); err != nil {
			return CommandInput{}, err
		}
		value.Metadata = metadata
		if err := value.Validate(); err != nil {
			return CommandInput{}, err
		}
		return CommandInput{CreateCaptureConnection: &value}, nil
	case captureplane.OperationPullCaptureTracks:
		value := *input.PullCaptureTracks
		if err := checkMetadata(value.Metadata); err != nil {
			return CommandInput{}, err
		}
		value.Metadata = metadata
		canonical, err := captureplane.CanonicalizePullCaptureTracksInput(value)
		if err != nil {
			return CommandInput{}, err
		}
		return CommandInput{PullCaptureTracks: &canonical}, nil
	case captureplane.OperationRenegotiateCaptureConnection:
		value := *input.RenegotiateCaptureConnection
		if err := checkMetadata(value.Metadata); err != nil {
			return CommandInput{}, err
		}
		value.Metadata = metadata
		if err := value.Validate(); err != nil {
			return CommandInput{}, err
		}
		return CommandInput{RenegotiateCaptureConnection: &value}, nil
	case captureplane.OperationInspectCaptureConnection:
		value := *input.InspectCaptureConnection
		if err := checkMetadata(value.Metadata); err != nil {
			return CommandInput{}, err
		}
		value.Metadata = metadata
		canonical, err := captureplane.CanonicalizeInspectCaptureConnectionInput(value)
		if err != nil {
			return CommandInput{}, err
		}
		return CommandInput{InspectCaptureConnection: &canonical}, nil
	case captureplane.OperationCloseCaptureTracks:
		value := *input.CloseCaptureTracks
		if err := checkMetadata(value.Metadata); err != nil {
			return CommandInput{}, err
		}
		value.Metadata = metadata
		canonical, err := captureplane.CanonicalizeCloseCaptureTracksInput(value)
		if err != nil {
			return CommandInput{}, err
		}
		return CommandInput{CloseCaptureTracks: &canonical}, nil
	case captureplane.OperationCloseCaptureConnection:
		value := *input.CloseCaptureConnection
		if err := checkMetadata(value.Metadata); err != nil {
			return CommandInput{}, err
		}
		value.Metadata = metadata
		canonical, err := captureplane.CanonicalizeCloseCaptureConnectionInput(value)
		if err != nil {
			return CommandInput{}, err
		}
		return CommandInput{CloseCaptureConnection: &canonical}, nil
	default:
		return CommandInput{}, fmt.Errorf("%w: unknown operation %s", ErrInvalidCommand, operation)
	}
}

func metadataZero(metadata captureplane.OperationMetadata) bool {
	return metadata.Identity.TenantID.IsZero() && metadata.Identity.SpaceID.IsZero() && metadata.Identity.EpisodeID.IsZero() && metadata.Identity.RecordingID.IsZero() && metadata.CaptureEpoch == 0 && metadata.PlanRevision == 0 && metadata.IdempotencyKey == ""
}
