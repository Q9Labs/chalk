package recordingbundle

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

func validateIdentifier(name, value string, required bool) error {
	if !required && value == "" {
		return nil
	}
	if strings.TrimSpace(value) == "" || len(value) > MaxIdentifierBytes || !utf8.ValidString(value) {
		return fmt.Errorf("%w: %s is invalid", ErrInvalidBundle, name)
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%w: %s contains a control character", ErrInvalidBundle, name)
		}
	}
	return nil
}

func (r TimeRange) validate(name string) error {
	if r.StartMilliseconds < 0 || r.EndMilliseconds < r.StartMilliseconds {
		return fmt.Errorf("%w: %s range is invalid", ErrInvalidBundle, name)
	}
	return nil
}

func (c EncryptionContext) validate() error {
	for name, value := range map[string]string{
		"environment":   c.Environment,
		"tenant_id":     c.TenantID,
		"episode_id":    c.EpisodeID,
		"recording_id":  c.RecordingID,
		"job_id":        c.JobID,
		"bundle_schema": c.BundleSchema,
	} {
		if err := validateIdentifier(name, value, true); err != nil {
			return err
		}
	}
	if c.BundleSchema != Version && c.BundleSchema != LegacyVersion {
		return fmt.Errorf("%w: encryption bundle schema %q", ErrUnknownBundleVersion, c.BundleSchema)
	}
	if err := validateIdentifier("key_handle", c.KeyHandle, false); err != nil {
		return err
	}
	return nil
}

func (t TrackIdentity) validate() error {
	for name, value := range map[string]string{
		"track_id": t.TrackID,
		"mid":      t.MID,
		"codec":    t.Codec,
		"layer":    t.Layer,
	} {
		if err := validateIdentifier(name, value, true); err != nil {
			return err
		}
	}
	if t.Epoch == 0 {
		return fmt.Errorf("%w: track epoch must be positive", ErrInvalidBundle)
	}
	return nil
}

func (m Manifest) validate() error {
	if m.Version != Version && m.Version != LegacyVersion {
		return fmt.Errorf("%w: manifest version %q", ErrUnknownBundleVersion, m.Version)
	}
	if err := validateIdentifier("recording_id", m.RecordingID, true); err != nil {
		return err
	}
	if m.CaptureEpoch == 0 {
		return fmt.Errorf("%w: capture epoch must be positive", ErrInvalidBundle)
	}
	if !validSHA256Hex(m.RecorderEnvelopeDigest) {
		return fmt.Errorf("%w: recorder envelope digest is invalid", ErrInvalidBundle)
	}
	if m.AllocationVersion <= 0 {
		return fmt.Errorf("%w: allocation version must be positive", ErrInvalidBundle)
	}
	if err := m.MonotonicRange.validate("monotonic"); err != nil {
		return err
	}
	if err := m.MediaRange.validate("media"); err != nil {
		return err
	}
	if !m.CloseReason.valid() {
		return fmt.Errorf("%w: close reason %q", ErrInvalidBundle, m.CloseReason)
	}
	if m.ContentSHA256 != "" && len(m.ContentSHA256) != 64 {
		return fmt.Errorf("%w: content checksum is invalid", ErrInvalidBundle)
	}
	if err := m.Encryption.validate(); err != nil {
		return err
	}
	if m.Encryption.BundleSchema != m.Version {
		return fmt.Errorf("%w: encryption schema does not match manifest", ErrInvalidBundle)
	}
	if m.Version == LegacyVersion && m.Encryption.KeyHandle != "" {
		return fmt.Errorf("%w: legacy manifest has a key handle", ErrInvalidBundle)
	}
	if m.Encryption.RecordingID != m.RecordingID {
		return fmt.Errorf("%w: encryption recording does not match manifest", ErrInvalidBundle)
	}
	return nil
}

func validSHA256Hex(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, char := range value {
		if !(char >= '0' && char <= '9') && !(char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}

func (t TrackEventKind) valid() bool {
	switch t {
	case TrackEventAdded, TrackEventRemoved, TrackEventReplaced, TrackEventEpochChanged:
		return true
	default:
		return false
	}
}

func (l LayoutEventKind) valid() bool {
	return l == LayoutEventSnapshot || l == LayoutEventChanged
}

func (g Gap) validate() error {
	if g.StartMonotonicMilliseconds < 0 || g.EndMonotonicMilliseconds < g.StartMonotonicMilliseconds || g.StartMediaMilliseconds < 0 || g.EndMediaMilliseconds < g.StartMediaMilliseconds {
		return fmt.Errorf("%w: gap range is invalid", ErrInvalidBundle)
	}
	if err := validateIdentifier("gap reason", g.Reason, true); err != nil {
		return err
	}
	if g.ReplacementAttempt == 0 && g.Terminal {
		return nil
	}
	return nil
}

// ValidateSequence verifies the cross-bundle ordering contract. A worker may
// recover after a crash with a new capture epoch, but it must never reuse a
// sequence number for the same recording.
func ValidateSequence(previous, next Bundle) error {
	if previous.Manifest.RecordingID != next.Manifest.RecordingID {
		return fmt.Errorf("%w: recording identity changed", ErrInvalidBundle)
	}
	if next.Manifest.Sequence <= previous.Manifest.Sequence {
		return fmt.Errorf("%w: bundle sequence is not strictly increasing", ErrInvalidBundle)
	}
	if next.Manifest.MonotonicRange.StartMilliseconds < previous.Manifest.MonotonicRange.EndMilliseconds {
		return fmt.Errorf("%w: bundle ranges overlap", ErrInvalidBundle)
	}
	return nil
}
