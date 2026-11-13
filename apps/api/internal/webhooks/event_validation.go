package webhooks

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var allowedSpaceChanges = map[string]struct{}{"admission_policy": {}, "default_episode_duration_seconds": {}, "linger_window_seconds": {}, "maximum_episode_duration_seconds": {}, "media_plane": {}, "metadata": {}, "name": {}, "recurring_policy": {}, "slug": {}, "transcript_language": {}}

func validateArtifactTransition(eventName EventName, status string, startedAt, completedAt, failedAt *time.Time, failure *ArtifactFailure) error {
	if !strings.HasSuffix(string(eventName), "."+status) || zeroTime(startedAt) || nonNilZeroTime(completedAt) || nonNilZeroTime(failedAt) {
		return errors.New("artifact event status does not match transition")
	}
	var consistent bool
	switch status {
	case "started":
		consistent = completedAt == nil && failedAt == nil && failure == nil
	case "completed":
		consistent = !zeroTime(completedAt) && failedAt == nil && failure == nil
	case "failed":
		consistent = !zeroTime(failedAt) && completedAt == nil && failure != nil && len(failure.Code) >= 1 && len(failure.Code) <= 96
	default:
		return errors.New("invalid artifact status")
	}
	if !consistent {
		return fmt.Errorf("invalid %s artifact snapshot", status)
	}
	return nil
}

func validUUIDv4(value string) bool {
	return validUUIDVersion(value, 4)
}

// Automatic Recordings use a deterministic UUIDv5; manual Recordings use UUIDv4.
func validRecordingID(value string) bool {
	return validUUIDVersion(value, 4) || validUUIDVersion(value, 5)
}

func validUUIDVersion(value string, version byte) bool {
	id, err := utilities.ParseID(value)
	if err != nil || id.String() != value {
		return false
	}
	bytes := id.Bytes()
	return bytes[6]>>4 == version && bytes[8]>>6 == 2
}

func zeroTime(value *time.Time) bool { return value == nil || value.IsZero() }

func nonNilZeroTime(value *time.Time) bool { return value != nil && value.IsZero() }

func timestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func optionalTimestamp(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := timestamp(*value)
	return &formatted
}

func validateSpaceEvent(name EventName, snapshot SpaceSnapshot, changedFields []string) error {
	switch {
	case !name.isOneOf(EventSpaceCreated, EventSpaceUpdated, EventSpaceArchived, EventSpaceRestored):
		return ErrInvalidEventType
	case name == EventSpaceUpdated && len(changedFields) == 0:
		return errors.New("space.updated requires changed_fields")
	case name != EventSpaceUpdated && len(changedFields) != 0:
		return errors.New("changed_fields only applies to space.updated")
	case name == EventSpaceArchived && snapshot.ArchivedAt == nil:
		return errors.New("space.archived requires archived_at")
	case name == EventSpaceRestored && snapshot.ArchivedAt != nil:
		return errors.New("space.restored requires a live space")
	case !validUUIDv4(snapshot.ID) || snapshot.CreatedAt.IsZero() || snapshot.UpdatedAt.IsZero():
		return errors.New("invalid space snapshot")
	}
	seen := make(map[string]struct{}, len(changedFields))
	for _, field := range changedFields {
		if _, ok := allowedSpaceChanges[field]; !ok {
			return errors.New("invalid space changed_fields")
		}
		if _, duplicate := seen[field]; duplicate {
			return errors.New("duplicate space changed_fields")
		}
		seen[field] = struct{}{}
	}
	return nil
}
