package composio

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/integrations"
)

func TestLiveCatalogMetadata(t *testing.T) {
	if os.Getenv("CHALK_COMPOSIO_LIVE_TESTS") != "1" {
		t.Skip("set CHALK_COMPOSIO_LIVE_TESTS=1 to run live Composio checks")
	}

	apiKey := os.Getenv("CHALK_COMPOSIO_API_KEY")
	if apiKey == "" {
		t.Fatal("CHALK_COMPOSIO_API_KEY is required for live Composio checks")
	}

	adapter, err := NewAdapter(Config{
		APIKey:         apiKey,
		BaseURL:        os.Getenv("CHALK_COMPOSIO_BASE_URL"),
		RequestTimeout: 15 * time.Second,
	})
	if err != nil {
		t.Fatalf("new adapter: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	catalog, err := integrations.DefaultCatalog()
	if err != nil {
		t.Fatalf("load integration catalog: %v", err)
	}

	services := catalog.Services()
	toolkitSlugs := make([]string, 0, len(services))
	seenToolkits := make(map[string]bool, len(services))
	for _, service := range services {
		if seenToolkits[service.ToolkitSlug] {
			continue
		}
		seenToolkits[service.ToolkitSlug] = true
		toolkitSlugs = append(toolkitSlugs, service.ToolkitSlug)
	}

	toolkits, err := adapter.ListToolkits(ctx, toolkitSlugs)
	if err != nil {
		t.Fatalf("list catalog toolkit metadata: %v", err)
	}
	toolkitsBySlug := make(map[string]Toolkit, len(toolkits))
	for _, toolkit := range toolkits {
		toolkitsBySlug[toolkit.Slug] = toolkit
	}

	for _, service := range services {
		t.Run(string(service.ID), func(t *testing.T) {
			toolkit, ok := toolkitsBySlug[service.ToolkitSlug]
			if !ok {
				t.Fatalf("%s toolkit metadata unresolved", service.ToolkitSlug)
			}
			if toolkit.Deprecated {
				t.Fatalf("%s toolkit is deprecated", service.ToolkitSlug)
			}
			if len(service.AllowedActions) == 0 {
				return
			}

			actionSlugs := make([]string, 0, len(service.AllowedActions))
			for _, action := range service.AllowedActions {
				actionSlugs = append(actionSlugs, action.Slug)
			}

			tools, err := adapter.ListTools(ctx, service.ToolkitSlug, actionSlugs)
			if err != nil {
				t.Fatalf("list %s tool metadata: %v", service.ID, err)
			}
			toolsBySlug := make(map[string]Tool, len(tools))
			for _, tool := range tools {
				toolsBySlug[tool.Slug] = tool
			}
			for _, action := range service.AllowedActions {
				tool, ok := toolsBySlug[action.Slug]
				if !ok {
					t.Fatalf("%s tool metadata unresolved", action.Slug)
				}
				if tool.ToolkitSlug != service.ToolkitSlug {
					t.Fatalf("%s toolkit = %q, want %q", action.Slug, tool.ToolkitSlug, service.ToolkitSlug)
				}
				if tool.Deprecated {
					t.Fatalf("%s tool is deprecated", action.Slug)
				}
			}

			if _, err := adapter.RequiredScopes(ctx, actionSlugs, ""); err != nil {
				t.Fatalf("resolve %s tool scopes: %v", service.ID, err)
			}
		})
	}
}
