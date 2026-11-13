package spaces

import "github.com/q9labs/chalk/apps/api/internal/utilities"

func validateEpisodeDurations(defaultDuration, maximumDuration int32) error {
	if defaultDuration < MinimumEpisodeDurationSeconds || defaultDuration > MaximumEpisodeDurationSeconds {
		return ErrInvalidEpisodeDuration
	}
	if maximumDuration < MinimumEpisodeDurationSeconds || maximumDuration > MaximumEpisodeDurationSeconds || defaultDuration > maximumDuration {
		return ErrInvalidEpisodeCeiling
	}
	return nil
}

func validateOptionalDuration(value OptionalInt32, invalid error) error {
	if !value.Set || value.Value == nil {
		return nil
	}
	if *value.Value < MinimumEpisodeDurationSeconds || *value.Value > MaximumEpisodeDurationSeconds {
		return invalid
	}
	return nil
}

func validateLingerWindow(value int32) error {
	if value < 0 || value > MaximumEpisodeDurationSeconds {
		return ErrInvalidLingerWindow
	}
	return nil
}

func validateOptionalLingerWindow(value OptionalInt32) error {
	if !value.Set || value.Value == nil {
		if value.Set && value.Value == nil {
			return ErrInvalidLingerWindow
		}
		return nil
	}
	return validateLingerWindow(*value.Value)
}

func validateTenantSpaceIDs(tenantID utilities.ID, spaceID utilities.ID) error {
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if spaceID.IsZero() {
		return ErrInvalidSpaceID
	}
	return nil
}

func requiredOptionalString(value utilities.OptionalString, invalid error) (utilities.OptionalString, error) {
	if !value.Set {
		return value, nil
	}
	if value.Value == nil {
		return utilities.OptionalString{}, invalid
	}

	prepared, err := utilities.RequiredString(*value.Value)
	if err != nil {
		return utilities.OptionalString{}, invalid
	}

	return utilities.OptionalString{Set: true, Value: &prepared}, nil
}
