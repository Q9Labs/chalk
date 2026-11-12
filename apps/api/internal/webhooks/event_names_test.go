package webhooks

import (
	"os"
	"regexp"
	"slices"
	"testing"
)

func spelledIn(t *testing.T, path, pattern string) []string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, match := range regexp.MustCompile(pattern).FindAllStringSubmatch(string(body), -1) {
		names = append(names, match[1])
	}
	return slices.Sorted(slices.Values(names))
}

// The registry is the one owner of event names. Everything that spells them
// outside Go must list exactly the same set, so adding an event in one place
// without the others fails here.
func TestEventNamesMatchEverySpelling(t *testing.T) {
	want := AllEventTypes()
	spellings := map[string][]string{
		"contract schema":    spelledIn(t, "../../../../contract/webhooks/v1/event.schema.json", `"event": \{ "const": "([a-z]+\.[a-z]+)" \}`),
		"generated SDK list": spelledIn(t, "../../../../sdks/typescript/client/src/webhooks/generated/event-v1.ts", `(?m)^  "([a-z]+\.[a-z]+)",$`),
		"docs table":         spelledIn(t, "../../../../apps/web/src/docs/content/webhook-events.mdx", "`([a-z]+\\.[a-z]+)`(?:,|\\s+\\|)"),
	}
	for name, got := range spellings {
		got = slices.Compact(got)
		if !slices.Equal(got, want) {
			t.Errorf("%s lists %v, want %v", name, got, want)
		}
	}

	schema, err := os.ReadFile("../../db/schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, constraint := range []string{"webhook_endpoint_revisions_event_types_check", "webhook_events_name_check"} {
		block := regexp.MustCompile(constraint + `[\s\S]*?\n\s*\)\s*\n?\s*\)`).Find(schema)
		if block == nil {
			t.Fatalf("constraint %s not found in schema.sql", constraint)
		}
		var got []string
		for _, match := range regexp.MustCompile(`'([a-z]+\.[a-z]+)'`).FindAllSubmatch(block, -1) {
			got = append(got, string(match[1]))
		}
		slices.Sort(got)
		wantForConstraint := want
		if constraint == "webhook_endpoint_revisions_event_types_check" {
			wantForConstraint = SubscribableEventTypes()
			slices.Sort(wantForConstraint)
		}
		if !slices.Equal(got, wantForConstraint) {
			t.Errorf("%s lists %v, want %v", constraint, got, wantForConstraint)
		}
	}
}
