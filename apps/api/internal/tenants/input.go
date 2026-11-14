package tenants

import (
	"strings"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func prepareCreateTenantInput(input *CreateTenantInput) error {
	name, err := utilities.RequiredString(input.Name)
	if err != nil {
		return ErrInvalidTenantName
	}
	input.Name = name

	if input.CORSAllowedOrigins, err = CORSOrigins(input.CORSAllowedOrigins); err != nil {
		return err
	}
	return prepareCreateNullableFields(input)
}

func prepareCreateNullableFields(input *CreateTenantInput) error {
	var planeErr, mediaErr, storageErr, logoErr, websiteErr error
	input.DefaultMediaPlane, planeErr = utilities.NullableString(input.DefaultMediaPlane)
	input.MediaPlaneProviderConfig, mediaErr = utilities.JSON(input.MediaPlaneProviderConfig)
	input.StorageProviderConfig, storageErr = utilities.JSON(input.StorageProviderConfig)
	input.LogoKey, logoErr = utilities.NullableString(input.LogoKey)
	input.Website, websiteErr = utilities.NullableString(input.Website)
	return firstTenantFieldError(planeErr, mediaErr, storageErr, logoErr, websiteErr)
}

func prepareUpdateTenantInput(input *UpdateTenantInput) error {
	if err := prepareRecordingRenderMode(input.RecordingRenderMode); err != nil {
		return err
	}
	if input.Name.Set {
		if input.Name.Value == nil {
			return ErrInvalidTenantName
		}
		name, err := utilities.RequiredString(*input.Name.Value)
		if err != nil {
			return ErrInvalidTenantName
		}
		input.Name.Value = &name
	}
	if input.CORSAllowedOrigins.Set {
		origins, err := CORSOrigins(input.CORSAllowedOrigins.Value)
		if err != nil {
			return err
		}
		input.CORSAllowedOrigins.Value = origins
	}
	if err := prepareUpdateNullableFields(input); err != nil {
		return err
	}
	return prepareArtifactPolicyUpdate(&input.ArtifactPolicy)
}

func prepareRecordingRenderMode(field utilities.OptionalString) error {
	if !field.Set {
		return nil
	}
	if field.Value != nil {
		switch RecordingRenderMode(*field.Value) {
		case RecordingRenderOnDemand, RecordingRenderAutomatic:
			return nil
		}
	}
	return ErrInvalidTenantField
}

func prepareUpdateNullableFields(input *UpdateTenantInput) error {
	var planeErr, mediaErr, storageErr, logoErr, websiteErr error
	input.DefaultMediaPlane, planeErr = utilities.OptionalNullableString(input.DefaultMediaPlane)
	input.MediaPlaneProviderConfig, mediaErr = utilities.OptionalNullableJSON(input.MediaPlaneProviderConfig)
	input.StorageProviderConfig, storageErr = utilities.OptionalNullableJSON(input.StorageProviderConfig)
	input.LogoKey, logoErr = utilities.OptionalNullableString(input.LogoKey)
	input.Website, websiteErr = utilities.OptionalNullableString(input.Website)
	return firstTenantFieldError(planeErr, mediaErr, storageErr, logoErr, websiteErr)
}

func firstTenantFieldError(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return ErrInvalidTenantField
		}
	}
	return nil
}

func ValidServiceID(id string) bool {
	return validStoredText(id, 128)
}

func ValidExternalID(id string) bool {
	return validStoredText(id, 512)
}

// The limits count characters, as PostgreSQL length() and the OpenAPI maxLength do.
// PostgreSQL text cannot hold NUL or invalid UTF-8, so reject them here instead of at the database.
func validStoredText(value string, maxCharacters int) bool {
	characters := utf8.RuneCountInString(value)
	return characters > 0 && characters <= maxCharacters && strings.TrimSpace(value) == value && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}
