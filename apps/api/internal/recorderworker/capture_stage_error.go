package recorderworker

import "fmt"

// captureStageError names the failed close step. The stage is a known literal,
// so failure sanitizing keeps it even when the cause is redacted.
func captureStageError(stage string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", stage, err)
}
