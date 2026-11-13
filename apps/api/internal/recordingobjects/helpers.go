package recordingobjects

import (
	"crypto/rand"
	"encoding/base64"
	"slices"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjectkey"
)

func hasCanonicalObjectKey(allocation Allocation) bool {
	authority := allocation.Authority
	return allocation.ObjectKey == recordingobjectkey.CaptureBundle(authority.TenantID, authority.RecordingID, authority.CaptureEpoch, allocation.SequenceNumber, allocation.ID) ||
		slices.Contains(recordingobjectkey.RetiredCaptureBundles(authority.RecordingID, authority.CaptureEpoch, allocation.SequenceNumber, allocation.ID), allocation.ObjectKey)
}

func opaqueToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func objectChecksum(facts objectstorage.ObjectFacts) ([]byte, error) {
	checksum, err := objectstorage.ObjectSHA256(facts)
	if err != nil {
		return nil, ErrObjectFactsMismatch
	}
	return checksum, nil
}

func sameAllocationRequest(left, right Allocation) bool {
	return SameAuthority(left.Authority, right.Authority) && left.ID == right.ID && left.SequenceNumber == right.SequenceNumber && left.Codec == right.Codec && sameLayer(left.Layer, right.Layer) && left.MonotonicStartMillis == right.MonotonicStartMillis && left.MonotonicEndMillis == right.MonotonicEndMillis && left.MediaStartMillis == right.MediaStartMillis && left.MediaEndMillis == right.MediaEndMillis && left.ObjectKey == right.ObjectKey && left.ExpectedByteSize == right.ExpectedByteSize && bytesEqual(left.ExpectedChecksumSHA256, right.ExpectedChecksumSHA256) && left.ContentType == right.ContentType && left.ExpiresAt.Equal(right.ExpiresAt) && bytesEqual(left.EncryptionContextDigest, right.EncryptionContextDigest)
}

func cloneAuthority(value Authority) Authority {
	value.EnvelopeDigest = append([]byte(nil), value.EnvelopeDigest...)
	return value
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func cloneAllocation(value Allocation) Allocation {
	value.Authority = cloneAuthority(value.Authority)
	value.Layer = cloneString(value.Layer)
	value.TokenHash = append([]byte(nil), value.TokenHash...)
	value.ExpectedChecksumSHA256 = append([]byte(nil), value.ExpectedChecksumSHA256...)
	value.EncryptionContextDigest = append([]byte(nil), value.EncryptionContextDigest...)
	value.ObjectChecksumSHA256 = append([]byte(nil), value.ObjectChecksumSHA256...)
	value.ManifestDigest = append([]byte(nil), value.ManifestDigest...)
	return value
}

func sameFinalizedFacts(allocation Allocation, input FinalizeInput) bool {
	return allocation.ExpectedByteSize == input.ExpectedByteSize && bytesEqual(allocation.ExpectedChecksumSHA256, input.ExpectedChecksumSHA256) && allocation.ContentType == strings.TrimSpace(input.ContentType) && allocation.ExpiresAt.Equal(input.ExpiresAt.UTC()) && allocation.Codec == strings.TrimSpace(input.Codec) && sameLayer(allocation.Layer, input.Layer) && allocation.MonotonicStartMillis == input.MonotonicStartMillis && allocation.MonotonicEndMillis == input.MonotonicEndMillis && allocation.MediaStartMillis == input.MediaStartMillis && allocation.MediaEndMillis == input.MediaEndMillis
}

func bytesEqual(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
