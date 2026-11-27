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

func TestPresentingOfficeFlags(t *testing.T) {
	t.Setenv(PresentingOfficeEnabled, "")
	t.Setenv(PresentingKeynoteEnabled, "")
	for _, environment := range []string{"local", "development", "staging", "nightly", "production", "unknown"} {
		t.Run(environment, func(t *testing.T) {
			capabilities, err := loadCapabilityConfig(environment)
			want := environment != "production" && environment != "unknown"
			if err != nil || capabilities.PresentingOffice != want || capabilities.PresentingKeynote != want {
				t.Fatalf("presenting office in %s: %+v, want %t (err: %v)", environment, capabilities, want, err)
			}
		})
	}

	t.Setenv(PresentingOfficeEnabled, "false")
	t.Setenv(PresentingKeynoteEnabled, "true")
	if capabilities, err := loadCapabilityConfig("local"); err != nil || capabilities.PresentingOffice || capabilities.PresentingKeynote {
		t.Fatalf("keynote stayed on without office: %+v, %v", capabilities, err)
	}

	t.Setenv(PresentingOfficeEnabled, "true")
	t.Setenv(PresentingKeynoteEnabled, "false")
	if capabilities, err := loadCapabilityConfig("production"); err != nil || !capabilities.PresentingOffice || capabilities.PresentingKeynote {
		t.Fatalf("explicit production office opt-in: %+v, %v", capabilities, err)
	}

	t.Setenv(PresentingOfficeEnabled, "maybe")
	if _, err := loadCapabilityConfig("local"); err == nil {
		t.Fatal("invalid office flag was accepted")
	}
}
