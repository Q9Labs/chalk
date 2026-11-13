package recordingrender

import (
	"bytes"
)

func sameFinalization(allocation Allocation, input FinalizeObjectInput) bool {
	return allocation.ExpectedContentType == input.ContentType && allocation.ExpectedByteSize == input.ByteSize && equalBytes(allocation.ExpectedSHA256, input.SHA256) && equalOptionalInt64(allocation.ExpectedDurationMillis, input.DurationMillis)
}

func cloneObjectFacts(value ObjectFacts) ObjectFacts {
	value.SHA256 = append([]byte(nil), value.SHA256...)
	return value
}

func cloneCaptureObject(value CaptureObject) CaptureObject {
	value.ObjectFacts = cloneObjectFacts(value.ObjectFacts)
	value.EnvelopeDigest = append([]byte(nil), value.EnvelopeDigest...)
	if value.Layer != nil {
		layer := *value.Layer
		value.Layer = &layer
	}
	return value
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func equalOptionalInt64(left, right *int64) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func equalBytes(left, right []byte) bool {
	return bytes.Equal(left, right)
}

func cloneHeaders(value map[string][]string) map[string][]string {
	result := make(map[string][]string, len(value))
	for name, values := range value {
		result[name] = append([]string(nil), values...)
	}
	return result
}
