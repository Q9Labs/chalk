// Package recordingobjectkey owns the object key layout of recordings. Every
// writer, validator and purge fence builds its keys here, so a layout change
// happens in one file. db/queries/recording_key_object_authority.sql still
// rebuilds the capture bundle key in SQL and must match CaptureBundle byte for
// byte.
package recordingobjectkey

import "fmt"

// TenantPrefix is the namespace that holds everything one tenant owns.
func TenantPrefix(tenantID string) string {
	return "tenants/" + tenantID + "/"
}

// TenantRecordingsPrefix is the namespace that holds one tenant's recording objects.
func TenantRecordingsPrefix(tenantID string) string {
	return TenantPrefix(tenantID) + "recordings/"
}

// CaptureBundle is the key of one capture bundle. Capture inputs must outlive the
// fixed temporary/ object lifecycle so a deferred export can resolve the frozen
// Episode presentation; their own source-window cleanup remains the authority for
// deletion.
func CaptureBundle(tenantID, recordingID string, captureEpoch, sequence int64, allocationID string) string {
	return fmt.Sprintf("%s%s/capture/%d/bundles/%d/%s.bundle", TenantRecordingsPrefix(tenantID), recordingID, captureEpoch, sequence, allocationID)
}

// RetiredCaptureBundles are the key shapes earlier releases wrote and old
// allocations still hold: under temporary/ and under the bare recordings/ root.
func RetiredCaptureBundles(recordingID string, captureEpoch, sequence int64, allocationID string) []string {
	return []string{
		fmt.Sprintf("temporary/recordings/%s/capture/%d/bundles/%d/%s.bundle", recordingID, captureEpoch, sequence, allocationID),
		fmt.Sprintf("recordings/%s/capture/%d/bundles/%d/%s.bundle", recordingID, captureEpoch, sequence, allocationID),
	}
}

// Presentation is the key prefix of one recording presentation.
func Presentation(tenantID, recordingID string, captureEpoch int64, presentationHandle string) string {
	return fmt.Sprintf("%s%s/presentation/%d/%s", TenantRecordingsPrefix(tenantID), recordingID, captureEpoch, presentationHandle)
}

// Render is the key of one rendered artifact.
func Render(tenantID, recordingID string, captureEpoch int64, purpose, allocationID, extension string) string {
	return fmt.Sprintf("%s%s/render/%d/%s/%s.%s", TenantRecordingsPrefix(tenantID), recordingID, captureEpoch, purpose, allocationID, extension)
}
