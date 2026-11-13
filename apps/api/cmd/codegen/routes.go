package main

import (
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
)

func (g *generator) addRoute(route httpapi.APIRouteContract) {
	if route.Path == "" || route.Method == "" {
		return
	}

	method := strings.ToLower(route.Method)
	operation := map[string]any{
		"operationId": route.OperationID,
		"summary":     operationSummary(route.OperationID),
		"responses":   g.responses(route),
	}

	if route.Description != "" {
		operation["description"] = route.Description
	}

	switch route.Auth {
	case httpapi.APIAuthSessionOrBearer:
		operation["security"] = []map[string][]string{
			{"sessionOrBearer": {}},
		}
	case httpapi.APIAuthParticipantMedia:
		operation["security"] = []map[string][]string{
			{"participantMediaBearer": {}},
		}
	case httpapi.APIAuthParticipantSync:
		operation["security"] = []map[string][]string{
			{"participantSyncBearer": {}},
		}
	default:
		operation["security"] = []map[string][]string{}
	}

	if len(route.Parameters) > 0 {
		operation["parameters"] = g.parameters(route.Parameters)
	}

	if route.RateLimit.Name != "" {
		operation["x-chalk-rate-limit"] = map[string]any{
			"name":           route.RateLimit.Name,
			"limit":          route.RateLimit.Limit,
			"window_seconds": int(route.RateLimit.Window.Seconds()),
		}
	}

	if route.Request != nil {
		if route.BodyLimitBytes > 0 {
			operation["x-chalk-max-body-bytes"] = route.BodyLimitBytes
		}
		operation["requestBody"] = map[string]any{
			"required": true,
			"content": map[string]any{
				"application/json": map[string]any{
					"schema": g.schemaRef(*route.Request, true),
				},
			},
		}
	}

	if g.doc.Paths[route.Path] == nil {
		g.doc.Paths[route.Path] = make(map[string]any)
	}
	g.doc.Paths[route.Path][method] = operation
}

func (g *generator) responses(route httpapi.APIRouteContract) map[string]any {
	responses := make(map[string]any)
	for _, response := range route.Responses {
		body := map[string]any{
			"description": http.StatusText(response.Status),
		}
		if len(response.Headers) > 0 {
			body["headers"] = headers(response.Headers)
		}
		if response.Schema != nil {
			contentType := response.ContentType
			if contentType == "" {
				contentType = "application/json"
			}
			body["content"] = map[string]any{
				contentType: map[string]any{
					"schema": g.schemaRef(*response.Schema, false),
				},
			}
		}
		responses[strconv.Itoa(response.Status)] = body
	}

	for status, errors := range groupErrors(route.Errors) {
		body := map[string]any{
			"description":         http.StatusText(status),
			"x-chalk-error-codes": errorCodes(errors),
			"content": map[string]any{
				"application/json": map[string]any{
					"schema": map[string]any{"$ref": "#/components/schemas/ErrorResponse"},
				},
			},
		}
		if status == http.StatusTooManyRequests {
			body["headers"] = headers(rateLimitResponseHeaders(true))
		}
		responses[strconv.Itoa(status)] = body
	}

	return responses
}

func headers(headers []httpapi.APIHeaderContract) map[string]any {
	result := make(map[string]any, len(headers))
	for _, header := range headers {
		result[header.Name] = map[string]any{
			"required": header.Required,
			"schema": map[string]any{
				"type": header.Type,
			},
		}
	}
	return result
}

func rateLimitResponseHeaders(includeRetryAfter bool) []httpapi.APIHeaderContract {
	responseHeaders := []httpapi.APIHeaderContract{
		{Name: ratelimit.HeaderLimit, Type: "integer", Required: true},
		{Name: ratelimit.HeaderRemaining, Type: "integer", Required: true},
	}
	if includeRetryAfter {
		responseHeaders = append(responseHeaders, httpapi.APIHeaderContract{Name: ratelimit.HeaderRetryAfter, Type: "integer", Required: true})
	}
	return responseHeaders
}

func (g *generator) parameters(parameters []httpapi.APIParameterContract) []map[string]any {
	result := make([]map[string]any, 0, len(parameters))
	for _, parameter := range parameters {
		result = append(result, map[string]any{
			"name":     parameter.Name,
			"in":       parameter.In,
			"required": parameter.Required,
			"schema":   g.parameterSchema(parameter),
		})
	}
	return result
}

func (g *generator) parameterSchema(parameter httpapi.APIParameterContract) map[string]any {
	if parameter.Type == "string" {
		if name, ok := idSchemaName("", parameter.Name); ok {
			return schemaReference(name)
		}
	}

	schema := map[string]any{"type": parameter.Type}
	if parameter.ItemsType != "" {
		items := map[string]any{"type": parameter.ItemsType}
		if len(parameter.Enum) > 0 {
			items["enum"] = parameter.Enum
		}
		schema["items"] = items
	} else if len(parameter.Enum) > 0 {
		schema["enum"] = parameter.Enum
	}
	if parameter.Pattern != "" {
		schema["pattern"] = parameter.Pattern
	}
	if parameter.MinLength > 0 {
		schema["minLength"] = parameter.MinLength
	}
	if parameter.MaxLength > 0 {
		schema["maxLength"] = parameter.MaxLength
	}
	if parameter.CodePointLength {
		schema[lengthUnitExtension] = codePointLengthUnit
	}
	return schema
}

func groupErrors(errors []httpapi.APIError) map[int][]httpapi.APIError {
	grouped := make(map[int][]httpapi.APIError)
	for _, err := range errors {
		grouped[err.Status] = append(grouped[err.Status], err)
	}
	return grouped
}

func errorCodes(errors []httpapi.APIError) []string {
	codes := make([]string, 0, len(errors))
	for _, err := range errors {
		codes = append(codes, err.Code)
	}
	sort.Strings(codes)
	return codes
}

func operationSummary(operationID string) string {
	if operationID == "" {
		return ""
	}

	var words []string
	start := 0
	for i := 1; i < len(operationID); i++ {
		if operationID[i] >= 'A' && operationID[i] <= 'Z' {
			words = append(words, operationID[start:i])
			start = i
		}
	}
	words = append(words, operationID[start:])

	summary := strings.Join(words, " ")
	return strings.ToUpper(summary[:1]) + strings.ToLower(summary[1:])
}

func errorResponseSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"required": []string{
			"error",
		},
		"properties": map[string]any{
			"error": map[string]any{
				"type": "object",
				"required": []string{
					"code",
					"message",
				},
				"properties": map[string]any{
					"code":    map[string]any{"type": "string"},
					"message": map[string]any{"type": "string"},
				},
				"additionalProperties": false,
			},
		},
		"additionalProperties": false,
	}
}
