package mediaplane

import (
	"errors"
	"strings"
	"testing"
)

func TestBindingPinsApplicationWithoutCredentials(t *testing.T) {
	first, err := NewBinding("cf_sfu", BindingSourceDeploymentDefault, "development-app-a")
	if err != nil {
		t.Fatal(err)
	}
	sameApplication, err := NewBinding("cf_sfu", BindingSourceTenantManaged, "development-app-a")
	if err != nil {
		t.Fatal(err)
	}
	otherApplication, err := NewBinding("cf_sfu", BindingSourceDeploymentDefault, "development-app-b")
	if err != nil {
		t.Fatal(err)
	}
	otherProvider, err := NewBinding("alternate_sfu", BindingSourceDeploymentDefault, "development-app-a")
	if err != nil {
		t.Fatal(err)
	}
	if first.AdapterFingerprint != sameApplication.AdapterFingerprint || first.AdapterFingerprint == otherApplication.AdapterFingerprint || first.AdapterFingerprint == otherProvider.AdapterFingerprint {
		t.Fatal("binding must identify the provider application, independent of credential configuration source")
	}
}

func TestBindingRejectsUntrustedOrNonCanonicalAuthority(t *testing.T) {
	valid, err := NewBinding("cf_sfu", BindingSourceDeploymentDefault, "development-app")
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Binding){
		func(binding *Binding) { binding.SchemaVersion = "media_plane_binding.v2" },
		func(binding *Binding) { binding.Provider = "../cf_sfu" },
		func(binding *Binding) { binding.ConfigurationSource = "caller" },
		func(binding *Binding) { binding.AdapterFingerprint = strings.ToUpper(binding.AdapterFingerprint) },
		func(binding *Binding) { binding.AdapterFingerprint = strings.Repeat("x", 64) },
	} {
		binding := valid
		change(&binding)
		if !errors.Is(binding.Validate(), ErrInvalidBinding) {
			t.Fatalf("invalid binding accepted: %#v", binding)
		}
	}
}
