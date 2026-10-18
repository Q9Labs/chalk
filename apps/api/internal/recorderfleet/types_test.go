package recorderfleet

import (
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
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

func TestConfigBindsArchiveToPoolRole(t *testing.T) {
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		config := newFleetFixture(t).config
		config.Key.Role = role
		config.MaxNodes = 1
		config.Release.Archive.Key = "recorder/" + string(role) + "/" + config.Release.Archive.SHA256 + ".tar.gz"
		if err := config.Validate(); err != nil {
			t.Fatalf("matching %s archive rejected: %v", role, err)
		}
		other := workeridentity.RoleCapture
		if role == other {
			other = workeridentity.RoleRender
		}
		config.Release.Archive.Key = "recorder/" + string(other) + "/" + config.Release.Archive.SHA256 + ".tar.gz"
		if err := config.Validate(); err == nil {
			t.Fatalf("%s pool accepted %s archive", role, other)
		}
	}
}
