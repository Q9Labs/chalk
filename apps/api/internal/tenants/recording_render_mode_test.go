package tenants

import (
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"testing"
)

func TestRecordingRenderModeValidation(t *testing.T) {
	for _, tc := range []struct {
		value *string
		valid bool
	}{
		{nil, false}, {renderModeValue(""), false}, {renderModeValue("always"), false},
		{renderModeValue("on_demand"), true}, {renderModeValue("automatic"), true},
	} {
		input := UpdateTenantInput{RecordingRenderMode: utilities.OptionalString{Set: true, Value: tc.value}}
		err := prepareUpdateTenantInput(&input)
		if (err == nil) != tc.valid {
			t.Fatalf("mode=%v valid=%t err=%v", tc.value, tc.valid, err)
		}
	}
	if err := prepareUpdateTenantInput(&UpdateTenantInput{}); err != nil {
		t.Fatalf("omitted mode must stay unchanged: %v", err)
	}
}
func renderModeValue(value string) *string { return &value }
