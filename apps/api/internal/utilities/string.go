package utilities

import (
	"encoding/json"
	"errors"
	"strings"
)

var ErrBlankString = errors.New("blank string")

// OptionalString represents a JSON field's three states: omitted, explicit
// null, or string value. A plain *string cannot tell omitted apart from null
// after JSON decoding, and database-specific nullable types do not belong in
// service packages.
type OptionalString struct {
	Set   bool
	Value *string
}

func (s *OptionalString) UnmarshalJSON(data []byte) error {
	s.Set = true

	if strings.TrimSpace(string(data)) == "null" {
		s.Value = nil
		return nil
	}

	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}

	s.Value = &value
	return nil
}

func RequiredString(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", ErrBlankString
	}

	return value, nil
}

func NullableString(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}

	prepared, err := RequiredString(*value)
	if err != nil {
		return nil, err
	}

	return &prepared, nil
}

func OptionalNullableString(value OptionalString) (OptionalString, error) {
	if !value.Set {
		return value, nil
	}

	prepared, err := NullableString(value.Value)
	if err != nil {
		return OptionalString{}, err
	}

	return OptionalString{Set: true, Value: prepared}, nil
}
