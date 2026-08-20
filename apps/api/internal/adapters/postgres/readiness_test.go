package postgres

import (
	"strings"
	"testing"
)

func TestValidateMigrationVersion(t *testing.T) {
	cases := []struct {
		name     string
		current  int64
		required int64
		wantErr  bool
	}{
		{name: "below target", current: 20260814211500, required: 20260819130000, wantErr: true},
		{name: "at target", current: 20260819130000, required: 20260819130000},
		{name: "ahead of target", current: 20260820120000, required: 20260819130000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateMigrationVersion(tc.current, tc.required)
			if tc.wantErr {
				if err == nil || !strings.Contains(err.Error(), "below required") {
					t.Fatalf("validateMigrationVersion() error = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("validateMigrationVersion() error = %v", err)
			}
		})
	}
}
