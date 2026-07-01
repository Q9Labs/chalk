package utilities_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestOptionalStringUnmarshalJSON(t *testing.T) {
	var body struct {
		Name utilities.OptionalString `json:"name"`
	}

	if err := json.Unmarshal([]byte(`{"name":" Acme "}`), &body); err != nil {
		t.Fatalf("unmarshal optional string: %v", err)
	}

	if !body.Name.Set {
		t.Fatal("name was not marked as set")
	}
	if body.Name.Value == nil || *body.Name.Value != " Acme " {
		t.Fatalf("name value = %v, want Acme with spaces", body.Name.Value)
	}
}

func TestOptionalStringUnmarshalJSONNull(t *testing.T) {
	var body struct {
		Name utilities.OptionalString `json:"name"`
	}

	if err := json.Unmarshal([]byte(`{"name":null}`), &body); err != nil {
		t.Fatalf("unmarshal optional string: %v", err)
	}

	if !body.Name.Set {
		t.Fatal("name was not marked as set")
	}
	if body.Name.Value != nil {
		t.Fatalf("name value = %v, want nil", body.Name.Value)
	}
}

func TestRequiredString(t *testing.T) {
	value, err := utilities.RequiredString(" Acme ")
	if err != nil {
		t.Fatalf("required string: %v", err)
	}

	if value != "Acme" {
		t.Fatalf("value = %q, want Acme", value)
	}
}

func TestRequiredStringRejectsBlank(t *testing.T) {
	_, err := utilities.RequiredString(" ")
	if !errors.Is(err, utilities.ErrBlankString) {
		t.Fatalf("error = %v, want %v", err, utilities.ErrBlankString)
	}
}

func TestNullableString(t *testing.T) {
	value := " Acme "

	prepared, err := utilities.NullableString(&value)
	if err != nil {
		t.Fatalf("nullable string: %v", err)
	}

	if prepared == nil || *prepared != "Acme" {
		t.Fatalf("value = %v, want Acme", prepared)
	}
}

func TestOptionalNullableStringKeepsOmitted(t *testing.T) {
	value, err := utilities.OptionalNullableString(utilities.OptionalString{})
	if err != nil {
		t.Fatalf("optional nullable string: %v", err)
	}

	if value.Set {
		t.Fatal("value was marked as set")
	}
}

func TestOptionalNullableStringKeepsNull(t *testing.T) {
	value, err := utilities.OptionalNullableString(utilities.OptionalString{Set: true})
	if err != nil {
		t.Fatalf("optional nullable string: %v", err)
	}

	if !value.Set {
		t.Fatal("value was not marked as set")
	}
	if value.Value != nil {
		t.Fatalf("value = %v, want nil", value.Value)
	}
}
