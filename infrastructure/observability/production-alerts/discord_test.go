package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"text/template"
	"time"
)

// Axiom's live custom webhook joins each result's columns into one GroupValues
// string. GroupKeys describes the columns; it is not a parallel values array.
func TestDiscordJoinedGroupsDoNotIndexPastValues(t *testing.T) {
	data := map[string]interface{}{
		"Action": "Open", "Value": 1, "Description": "Synthetic monitor description",
		"GroupKeys":   []string{"tenant", "rule", "headline", "summary", "next", "engineers"},
		"GroupValues": []string{"synthetic & delivery-test & TEST: Chalk alert delivery & No customer failure was induced. & This only tests notification delivery; no customer action is needed. & For engineers: delivery-test."},
	}
	content := renderDiscord(t, data)
	if !strings.Contains(content, "TEST: Chalk alert delivery") || strings.Contains(content, "stopped reporting") {
		t.Fatal(content)
	}
}

func renderDiscord(t *testing.T, data map[string]interface{}) string {
	t.Helper()
	body, err := os.ReadFile("discord-body.tmpl")
	if err != nil {
		t.Fatal(err)
	}
	tmpl, err := template.New("discord").Parse(string(body))
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := tmpl.Execute(&output, data); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Content         string `json:"content"`
		AllowedMentions struct {
			Parse []string `json:"parse"`
		} `json:"allowed_mentions"`
	}
	if err := json.Unmarshal(output.Bytes(), &payload); err != nil {
		t.Fatalf("Discord body is not JSON: %v", err)
	}
	if payload.Content == "" || len([]rune(payload.Content)) > 2000 {
		t.Fatal("Discord content must contain 1–2000 characters")
	}
	if payload.AllowedMentions.Parse == nil || len(payload.AllowedMentions.Parse) != 0 {
		t.Fatal("Discord mentions must be explicitly disabled")
	}
	return payload.Content
}

func discordGroup(item snapshot) string {
	return "\n" + strings.Join([]string{item.Tenant, item.Rule, item.Headline, item.Summary, item.Next, item.Engineers}, "\n") + "\n"
}

func TestDiscordFinalTextForEveryRuleAndClosure(t *testing.T) {
	body, err := os.ReadFile("testdata/discord-messages.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct{ Rule, Action, Content string }
	if err := json.Unmarshal(body, &fixtures); err != nil {
		t.Fatal(err)
	}
	openText := make(map[string]string)
	for _, fixture := range fixtures {
		if fixture.Action == "Open" {
			openText[fixture.Rule] = fixture.Content
		}
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Rule+"-"+fixture.Action, func(t *testing.T) {
			item := snapshot{Rule: fixture.Rule, Value: 2, Tenant: "synthetic", TenantName: "Example school"}
			switch fixture.Rule {
			case "recording", "export", "transcript", "webhook", "delivery-test":
				if fixture.Rule == "delivery-test" {
					item.Tenant = ""
				}
				if fixture.Rule == "export" || fixture.Rule == "transcript" {
					expires := time.Date(2099, 1, 1, 12, 0, 0, 0, time.UTC)
					item.ExpiresAt = &expires
				}
				formatMessage(&item)
				item.Engineers = fmt.Sprintf("For engineers: %s; `pnpm diag trace <32-hex-trace-id>` from the affected journey.", fixture.Rule)
			default:
				lines := strings.Split(openText[fixture.Rule], "\n")
				item.Tenant = ""
				item.Headline, item.Summary, item.Next, item.Engineers = lines[0], lines[1], lines[2], lines[3]
			}
			data := map[string]interface{}{"Action": fixture.Action, "Value": 2, "Description": "Synthetic monitor description", "GroupKeys": []string{"alert_message"}, "GroupValues": []string{discordGroup(item)}}
			if got := renderDiscord(t, data); got != fixture.Content {
				t.Fatalf("got:\n%s\nwant:\n%s", got, fixture.Content)
			}
		})
	}
}

func TestDiscordPackedMessagesPreserveUnicodeAndAmpersands(t *testing.T) {
	item := snapshot{Rule: "recording", Tenant: "synthetic", TenantName: "مدرسة 学校 & school \"one\"", Value: 1}
	formatMessage(&item)
	item.Engineers = "For engineers: recording."
	data := map[string]interface{}{"Action": "Open", "Value": 1, "Description": "", "GroupKeys": []string{"alert_message"}, "GroupValues": []string{discordGroup(item)}}
	content := renderDiscord(t, data)
	if !strings.Contains(content, item.TenantName) {
		t.Fatal(content)
	}
}

func TestDiscordFreshnessWithoutGroupsAndLegacyTest(t *testing.T) {
	for _, action := range []string{"Open", "Closed"} {
		data := map[string]interface{}{"Action": action, "Value": 0, "Description": "Chalk may be working, but nobody would be told about a job or webhook failure until this is fixed.", "GroupKeys": []string(nil), "GroupValues": []string(nil)}
		content := renderDiscord(t, data)
		if !strings.Contains(content, "The alert system has stopped reporting") {
			t.Fatal(content)
		}
		data["GroupKeys"] = []string{"chalk_alert_rule", "chalk_alert_summary"}
		data["GroupValues"] = []string{"delivery-test & TEST: Chalk production alert delivery proof; no user failure was induced."}
		content = renderDiscord(t, data)
		if !strings.Contains(content, "TEST: Chalk alert delivery") || strings.Contains(content, "stopped reporting") {
			t.Fatal(content)
		}
	}
}

func TestDiscordBatchesFitAndDiscloseOmittedGroups(t *testing.T) {
	var groups []string
	for i := 0; i < 8; i++ {
		item := snapshot{Rule: "export", Tenant: fmt.Sprintf("synthetic-%d", i), TenantName: fmt.Sprintf("Example school %d", i), Value: 2}
		formatMessage(&item)
		item.Engineers = "For engineers: export; `pnpm diag trace <32-hex-trace-id>` from the affected journey."
		groups = append(groups, discordGroup(item))
	}
	data := map[string]interface{}{"Action": "Open", "Value": 2, "Description": "", "GroupKeys": []string{"alert_message"}, "GroupValues": groups}
	for _, action := range []string{"Open", "Closed"} {
		data["Action"] = action
		content := renderDiscord(t, data)
		if !strings.Contains(content, "additional alert groups did not fit") || !strings.Contains(content, "Example school 0") {
			t.Fatal(content)
		}
	}
	data["GroupValues"] = []string{discordGroup(snapshot{Rule: "export", Headline: "A class video could not be produced", Summary: strings.Repeat("学", 1000), Engineers: "For engineers: export."})}
	content := renderDiscord(t, data)
	if !strings.Contains(content, "1 additional alert groups did not fit") {
		t.Fatal(content)
	}
}

func TestDiscordLegacyTestWithoutTenant(t *testing.T) {
	data := map[string]interface{}{"Action": "Open", "Value": 1, "Description": "", "GroupKeys": []string{"tenant", "rule", "headline", "summary", "next", "engineers"}, "GroupValues": []string{" & delivery-test & TEST: Chalk alert delivery & No customer failure was induced. & This only tests notification delivery; no customer action is needed. & For engineers: delivery-test."}}
	content := renderDiscord(t, data)
	if !strings.Contains(content, "TEST: Chalk alert delivery") || strings.Contains(content, "stopped reporting") {
		t.Fatal(content)
	}
}
