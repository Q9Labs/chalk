package main

import (
	"encoding/json"
	"os"
	"reflect"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
)

// A length written with this extension counts Unicode code points, as the server does.
// Every other length stays a plain string length, which the TypeScript client counts in UTF-16 units.
const (
	lengthUnitExtension = "x-chalk-length-unit"
	codePointLengthUnit = "code-points"
)

type openAPIDoc struct {
	OpenAPI    string                    `json:"openapi"`
	Info       openAPIInfo               `json:"info"`
	Servers    []openAPIServer           `json:"servers"`
	Paths      map[string]map[string]any `json:"paths"`
	Components openAPIComponents         `json:"components"`
}

type openAPIInfo struct {
	Title   string         `json:"title"`
	Version string         `json:"version"`
	License openAPILicense `json:"license"`
}

type openAPILicense struct {
	Name       string `json:"name"`
	Identifier string `json:"identifier"`
}

type openAPIServer struct {
	URL         string `json:"url"`
	Description string `json:"description"`
}

type openAPIComponents struct {
	SecuritySchemes map[string]any            `json:"securitySchemes"`
	Schemas         map[string]map[string]any `json:"schemas"`
}

type generator struct {
	doc         openAPIDoc
	schemaNames map[reflect.Type]string
}

func main() {
	routes := httpapi.PreviewRouteContracts()
	gen := newGenerator(routes)
	for _, route := range routes {
		gen.addRoute(route)
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(gen.doc); err != nil {
		panic(err)
	}
}

func newGenerator(routes []httpapi.APIRouteContract) *generator {
	gen := &generator{
		schemaNames: schemaNames(routes),
		doc: openAPIDoc{
			OpenAPI: "3.1.0",
			Info: openAPIInfo{
				Title:   "Chalk API contract preview",
				Version: "0.0.0-preview",
				License: openAPILicense{
					Name:       "Apache-2.0",
					Identifier: "Apache-2.0",
				},
			},
			Servers: []openAPIServer{
				{URL: "https://api.chalkmeet.com", Description: "Production API"},
			},
			Paths: make(map[string]map[string]any),
			Components: openAPIComponents{
				SecuritySchemes: map[string]any{
					"sessionOrBearer": map[string]any{
						"type":        "http",
						"scheme":      "bearer",
						"description": "Tenant-scoped API key or local system bearer credential. User sessions are not accepted.",
					},
					"participantMediaBearer": map[string]any{
						"type":         "http",
						"scheme":       "bearer",
						"bearerFormat": "JWT",
						"description":  "Short-lived participant media credential bound to one live participant generation and media-provider connection.",
					},
					"participantSyncBearer": map[string]any{
						"type":         "http",
						"scheme":       "bearer",
						"bearerFormat": "JWT",
						"description":  "Short-lived Sync participant credential bound to one Space Episode and participant generation.",
					},
				},
				Schemas: make(map[string]map[string]any),
			},
		},
	}
	gen.doc.Components.Schemas["ErrorResponse"] = errorResponseSchema()
	gen.doc.Components.Schemas["TenantMediaLimitCode"] = map[string]any{
		"type": "string", "enum": []string{tenantlimits.RecordingLimitCode, tenantlimits.LiveEpisodeLimitCode},
		"description": "HTTP 409 tenant media admission errors. Recording starts use the private Sync provider bridge; live Episode creation uses the public API.",
	}
	for name, schema := range scalarSchemas() {
		gen.doc.Components.Schemas[name] = schema
	}
	for name, schema := range recordingArtifactSchemas() {
		gen.doc.Components.Schemas[name] = schema
	}
	gen.doc.Components.Schemas["Pagination"] = paginationSchema()
	for name, schema := range providerConfigSchemas() {
		gen.doc.Components.Schemas[name] = schema
	}
	return gen
}

func schemaNames(routes []httpapi.APIRouteContract) map[reflect.Type]string {
	names := make(map[reflect.Type]string)
	for _, route := range routes {
		if route.Request != nil {
			names[dereference(reflect.TypeOf(route.Request.Type))] = route.Request.Name
		}
		for _, response := range route.Responses {
			if response.Schema != nil {
				names[dereference(reflect.TypeOf(response.Schema.Type))] = response.Schema.Name
			}
		}
	}
	return names
}
