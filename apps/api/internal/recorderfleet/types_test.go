package recorderfleet

import (
	"strings"
	"testing"
)

func TestConfigArchiveBucketNamesMatchReleasePipeline(t *testing.T) {
	for _, bucket := range []string{"example-artifacts", "example.artifacts", "1example-artifacts", "123", strings.Repeat("a", 63)} {
		t.Run(bucket, func(t *testing.T) {
			config := newFleetFixture(t).config
			config.Release.Archive.Bucket = bucket
			if err := config.Validate(); err != nil {
				t.Fatalf("release-compatible bucket %q rejected: %v", bucket, err)
			}
		})
	}
	for _, bucket := range []string{"", "ab", "Example-artifacts", "example_artifacts", ".example-artifacts", "example-artifacts-", "example-artifacts\n", strings.Repeat("a", 64)} {
		t.Run(bucket, func(t *testing.T) {
			config := newFleetFixture(t).config
			config.Release.Archive.Bucket = bucket
			if err := config.Validate(); err == nil {
				t.Fatalf("invalid bucket %q accepted", bucket)
			}
		})
	}
}
