package httpapi

import "time"

// optionalTimeRequest preserves omitted and explicit-null timestamps in PATCH
// request bodies without leaking transport details into domain packages.
type optionalTimeRequest struct {
	Set   bool
	Value *time.Time
}

func (value *optionalTimeRequest) UnmarshalJSON(data []byte) error {
	value.Set = true
	if string(data) == "null" {
		value.Value = nil
		return nil
	}

	var timestamp time.Time
	if err := timestamp.UnmarshalJSON(data); err != nil {
		return err
	}
	value.Value = &timestamp
	return nil
}
