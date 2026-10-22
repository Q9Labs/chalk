package recorderfleet

import "time"

// ProviderRateLimitError leaves scheduling to the controller, not worker claims.
type ProviderRateLimitError struct {
	RetryAt time.Time
}

func (err *ProviderRateLimitError) Error() string            { return "recorder fleet provider rate limited" }
func (err *ProviderRateLimitError) Unwrap() error            { return ErrProviderUnavailable }
func (err *ProviderRateLimitError) RetryDeadline() time.Time { return err.RetryAt }
