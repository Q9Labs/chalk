package main

// applyAdmissionFieldConstraints bounds the identity and profile text an Episode admission accepts.
func applyAdmissionFieldConstraints(schema map[string]any, request bool, schemaName string, fieldName string) {
	if fieldName == "identity_external_id" {
		schema["minLength"] = 1
		schema["maxLength"] = 256
	}
	if request && schemaName == "AdmitEpisodeParticipantRequest" && fieldName == "description" {
		schema["maxLength"] = 80
		schema[lengthUnitExtension] = codePointLengthUnit
	}
}
