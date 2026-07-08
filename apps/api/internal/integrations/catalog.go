package integrations

import (
	"errors"
	"fmt"
	"slices"
)

var (
	ErrDuplicateServiceID = errors.New("duplicate integration service id")
	ErrInvalidCatalog     = errors.New("invalid integration catalog")
)

type Catalog struct {
	services []ServiceEntry
	byID     map[ServiceID]ServiceEntry
}

func DefaultCatalog() (Catalog, error) {
	return NewCatalog(defaultServiceEntries())
}

func NewCatalog(entries []ServiceEntry) (Catalog, error) {
	services := make([]ServiceEntry, 0, len(entries))
	byID := make(map[ServiceID]ServiceEntry, len(entries))
	for _, entry := range entries {
		if entry.ID == "" || entry.Provider == "" || entry.ToolkitSlug == "" || entry.DisplayName == "" || entry.Family == "" {
			return Catalog{}, ErrInvalidCatalog
		}
		if _, exists := byID[entry.ID]; exists {
			return Catalog{}, fmt.Errorf("%w: %s", ErrDuplicateServiceID, entry.ID)
		}
		if entry.Provider != ProviderComposio {
			return Catalog{}, fmt.Errorf("%w: %s", ErrInvalidProvider, entry.Provider)
		}
		if largeToolkit(entry.ToolkitSlug) && len(entry.AllowedActions) == 0 {
			return Catalog{}, fmt.Errorf("%w: missing action policy for %s", ErrInvalidCatalog, entry.ID)
		}
		for _, action := range entry.AllowedActions {
			if action.ID == "" || action.Slug == "" || action.DisplayName == "" {
				return Catalog{}, fmt.Errorf("%w: invalid action policy for %s", ErrInvalidCatalog, entry.ID)
			}
		}

		entry.Enabled = true
		entry.AllowedActions = slices.Clone(entry.AllowedActions)
		entry.CapabilityTags = slices.Clone(entry.CapabilityTags)
		entry.RiskTags = slices.Clone(entry.RiskTags)
		services = append(services, entry)
		byID[entry.ID] = entry
	}

	return Catalog{services: services, byID: byID}, nil
}

func (c Catalog) Services() []ServiceEntry {
	services := make([]ServiceEntry, len(c.services))
	copy(services, c.services)
	return services
}

func (c Catalog) Get(id ServiceID) (ServiceEntry, bool) {
	entry, ok := c.byID[id]
	return entry, ok
}

func (c Catalog) ValidateGoogleGranularity() error {
	for _, service := range []ServiceID{
		"gmail",
		"google_calendar",
		"google_drive",
		"google_docs",
		"google_sheets",
		"google_slides",
		"google_forms",
		"google_tasks",
		"google_meet",
	} {
		entry, ok := c.Get(service)
		if !ok {
			return fmt.Errorf("%w: missing %s", ErrInvalidCatalog, service)
		}
		if entry.ToolkitSlug == "google" || entry.ToolkitSlug == "googleworkspace" {
			return fmt.Errorf("%w: broad google toolkit for %s", ErrInvalidCatalog, service)
		}
	}

	return nil
}

func largeToolkit(slug string) bool {
	return slices.Contains([]string{
		"github",
		"gmail",
		"googlecalendar",
		"googledrive",
		"googledocs",
		"googlesheets",
		"hubspot",
		"outlook",
		"salesforce",
		"slack",
		"zendesk",
	}, slug)
}

func defaultServiceEntries() []ServiceEntry {
	return []ServiceEntry{
		service("Google", "gmail", "Gmail", "gmail", []ActionPolicy{
			action("send_email", "GMAIL_SEND_EMAIL", "Send email", []string{"write"}, []string{"external_send"}),
			action("create_draft", "GMAIL_CREATE_EMAIL_DRAFT", "Create draft", []string{"write"}, []string{"draft"}),
		}, []string{"email", "read", "write"}),
		service("Google", "google_calendar", "Google Calendar", "googlecalendar", []ActionPolicy{
			action("create_event", "GOOGLECALENDAR_CREATE_EVENT", "Create event", []string{"write"}, []string{"calendar_write"}),
			action("find_event", "GOOGLECALENDAR_FIND_EVENT", "Find event", []string{"read"}, nil),
		}, []string{"calendar", "read", "write"}),
		service("Google", "google_drive", "Google Drive", "googledrive", []ActionPolicy{
			action("find_file", "GOOGLEDRIVE_FIND_FILE", "Find file", []string{"read"}, nil),
			action("upload_file", "GOOGLEDRIVE_UPLOAD_FILE", "Upload file", []string{"write"}, []string{"file_write"}),
		}, []string{"files", "read", "write"}),
		service("Google", "google_docs", "Google Docs", "googledocs", []ActionPolicy{
			action("create_document", "GOOGLEDOCS_CREATE_DOCUMENT", "Create document", []string{"write"}, []string{"document_write"}),
		}, []string{"docs", "write"}),
		service("Google", "google_sheets", "Google Sheets", "googlesheets", []ActionPolicy{
			action("update_values", "GOOGLESHEETS_VALUES_UPDATE", "Update values", []string{"write"}, []string{"spreadsheet_write"}),
		}, []string{"sheets", "write"}),
		service("Google", "google_slides", "Google Slides", "googleslides", nil, []string{"slides", "write"}),
		service("Google", "google_forms", "Google Forms", "googleforms", nil, []string{"forms", "write"}),
		service("Google", "google_tasks", "Google Tasks", "googletasks", nil, []string{"tasks", "write"}),
		service("Google", "google_meet", "Google Meet", "googlemeet", nil, []string{"meetings", "read"}),
		service("Work", "slack", "Slack", "slack", []ActionPolicy{
			action("send_message", "SLACK_SEND_MESSAGE", "Send channel message", []string{"write"}, []string{"external_send"}),
		}, []string{"chat", "write"}),
		service("Work", "linear", "Linear", "linear", []ActionPolicy{
			action("create_issue", "LINEAR_CREATE_LINEAR_ISSUE", "Create issue", []string{"write"}, []string{"issue_write"}),
		}, []string{"issues", "write"}),
		service("Work", "github", "GitHub", "github", []ActionPolicy{
			action("create_issue", "GITHUB_CREATE_AN_ISSUE", "Create issue", []string{"write"}, []string{"issue_write"}),
		}, []string{"developer", "write"}),
		service("Work", "notion", "Notion", "notion", []ActionPolicy{
			action("create_page", "NOTION_CREATE_NOTION_PAGE", "Create page", []string{"write"}, []string{"document_write"}),
		}, []string{"notes", "write"}),
	}
}

func service(family string, id ServiceID, name string, toolkit string, actions []ActionPolicy, tags []string) ServiceEntry {
	return ServiceEntry{
		ID:             id,
		Family:         family,
		DisplayName:    name,
		Provider:       ProviderComposio,
		ToolkitSlug:    toolkit,
		ToolkitVersion: "latest",
		AllowedActions: actions,
		CapabilityTags: tags,
	}
}

func action(id ActionID, slug string, name string, tags []string, risks []string) ActionPolicy {
	return ActionPolicy{
		ID:             id,
		Slug:           slug,
		DisplayName:    name,
		CapabilityTags: tags,
		RiskTags:       risks,
	}
}
