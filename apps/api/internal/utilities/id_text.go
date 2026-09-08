package utilities

// MarshalText preserves IDs in JSON payloads and canonical request fingerprints.
func (id ID) MarshalText() ([]byte, error) {
	return []byte(id.String()), nil
}

func (id *ID) UnmarshalText(text []byte) error {
	if len(text) == 0 {
		*id = ID{}
		return nil
	}
	parsed, err := ParseID(string(text))
	if err != nil {
		return err
	}
	*id = parsed
	return nil
}
