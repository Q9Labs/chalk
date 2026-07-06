package integrations

import (
	"errors"
	"testing"
)

func TestDefaultCatalogValidatesGoogleGranularity(t *testing.T) {
	catalog, err := DefaultCatalog()
	if err != nil {
		t.Fatalf("default catalog: %v", err)
	}

	if err := catalog.ValidateGoogleGranularity(); err != nil {
		t.Fatalf("validate google granularity: %v", err)
	}
}

func TestCatalogRejectsDuplicateServiceIDs(t *testing.T) {
	_, err := NewCatalog([]ServiceEntry{
		{ID: "slack", Family: "Work", DisplayName: "Slack", Provider: ProviderComposio, ToolkitSlug: "slack", AllowedActions: []ActionPolicy{{Slug: "SLACK_SEND_MESSAGE"}}},
		{ID: "slack", Family: "Work", DisplayName: "Slack Again", Provider: ProviderComposio, ToolkitSlug: "slack", AllowedActions: []ActionPolicy{{Slug: "SLACK_SEND_MESSAGE"}}},
	})
	if !errors.Is(err, ErrDuplicateServiceID) {
		t.Fatalf("error = %v, want duplicate service id", err)
	}
}

func TestCatalogRejectsMissingLargeToolkitAllowlist(t *testing.T) {
	_, err := NewCatalog([]ServiceEntry{
		{ID: "slack", Family: "Work", DisplayName: "Slack", Provider: ProviderComposio, ToolkitSlug: "slack"},
	})
	if !errors.Is(err, ErrInvalidCatalog) {
		t.Fatalf("error = %v, want invalid catalog", err)
	}
}
