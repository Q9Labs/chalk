package main

import (
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func TestParseArchiveCDNIsAllOrNone(t *testing.T) {
	cdn, err := parseArchiveCDN("", "", "")
	if err != nil || cdn != nil {
		t.Fatalf("empty settings must keep S3 links: %v %v", cdn, err)
	}
	for _, partial := range [][3]string{{"https://d1.cloudfront.net", "", ""}, {"", "K", ""}, {"", "", "a2V5"}, {"https://d1.cloudfront.net", "K", ""}} {
		if _, err := parseArchiveCDN(partial[0], partial[1], partial[2]); !errors.Is(err, recorderfleet.ErrInvalidConfig) {
			t.Errorf("partial %v: %v", partial, err)
		}
	}
}
