package config

import "testing"

func TestScreenAnnotationDefault(t *testing.T) {
	t.Setenv(ScreenAnnotationEnabled, "")
	for _, environment := range []string{"local", "development", "staging", "nightly", "production", "unknown"} {
		t.Run(environment, func(t *testing.T) {
			capabilities, err := loadCapabilityConfig(environment)
			want := environment != "production" && environment != "unknown"
			if err != nil || capabilities.ScreenAnnotation != want {
				t.Fatalf("screen annotation in %s: got %t, want %t (err: %v)", environment, capabilities.ScreenAnnotation, want, err)
			}
		})
	}

	t.Setenv(ScreenAnnotationEnabled, "true")
	if capabilities, err := loadCapabilityConfig("production"); err != nil || !capabilities.ScreenAnnotation {
		t.Fatalf("explicit production opt-in was ignored: %+v, %v", capabilities, err)
	}
}
