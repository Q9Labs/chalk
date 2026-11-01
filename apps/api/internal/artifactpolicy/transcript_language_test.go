package artifactpolicy

import (
	"encoding/json"
	"testing"
)

func TestTranscriptLanguageBoundaryAndPrecedence(t *testing.T) {
	for _, value := range TranscriptLanguageValues() {
		mode, err := ParseTranscriptLanguage(value)
		if err != nil || mode.String() != value {
			t.Fatalf("parse %q: %v %v", value, mode, err)
		}
		if (mode.Kind() == TranscriptLanguageAuto) != (value == "auto") {
			t.Fatalf("wrong discriminant for %q", value)
		}
	}
	for _, value := range []string{"", "EN", "en-US", "english", "xx", " auto ", "null"} {
		if _, err := ParseTranscriptLanguage(value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	var update OptionalTranscriptLanguage
	if err := json.Unmarshal([]byte(`null`), &update); err != nil || !update.Set || update.Value != nil {
		t.Fatalf("inherit: %+v %v", update, err)
	}
	if err := json.Unmarshal([]byte(`"auto"`), &update); err != nil || update.Value == nil || update.Value.Kind() != TranscriptLanguageAuto {
		t.Fatalf("explicit auto: %+v %v", update, err)
	}
	if err := json.Unmarshal([]byte(`"en-US"`), &update); err == nil {
		t.Fatal("accepted regional code")
	}
	tenant, _ := ParseTranscriptLanguage("ur")
	space, _ := ParseTranscriptLanguage("ar")
	explicit, _ := ParseTranscriptLanguage("en")
	auto := TranscriptLanguage{}
	for _, test := range []struct {
		explicit, space *TranscriptLanguage
		want            string
	}{
		{nil, nil, "ur"}, {nil, &space, "ar"}, {&explicit, &space, "en"}, {&auto, &space, "auto"}, {nil, &auto, "auto"},
	} {
		if got := ResolveTranscriptLanguage(test.explicit, test.space, tenant).String(); got != test.want {
			t.Fatalf("resolved %q want %q", got, test.want)
		}
	}
}
