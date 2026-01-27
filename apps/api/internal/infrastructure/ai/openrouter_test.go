package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewOpenRouterProvider_DefaultModel(t *testing.T) {
	p := NewOpenRouterProvider("api-key", "")
	assert.Equal(t, defaultModel, p.model)
	assert.Equal(t, "api-key", p.apiKey)
}

func TestNewOpenRouterProvider_CustomModel(t *testing.T) {
	p := NewOpenRouterProvider("api-key", "custom/model")
	assert.Equal(t, "custom/model", p.model)
}

func TestOpenRouterProvider_Name(t *testing.T) {
	p := NewOpenRouterProvider("key", "")
	assert.Equal(t, "openrouter", p.Name())
}

func TestOpenRouterProvider_GenerateSummary_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)
		assert.Equal(t, "Bearer test-key", r.Header.Get("Authorization"))
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
		assert.Equal(t, "https://chalk-api.q9labs.ai", r.Header.Get("HTTP-Referer"))

		// Decode request to verify structure
		var req map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
		assert.Equal(t, "test-model", req["model"])
		assert.Equal(t, 0.3, req["temperature"])

		response := map[string]any{
			"choices": []map[string]any{
				{
					"message": map[string]string{
						"content": `{"summary":"Meeting discussed project timelines.","action_items":["Review docs by Friday","Schedule follow-up"]}`,
					},
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	p := &OpenRouterProvider{
		apiKey: "test-key",
		model:  "test-model",
		client: server.Client(),
	}
	// Override the URL by using a custom client
	originalClient := p.client
	p.client = &http.Client{
		Transport: &testTransport{server.URL, originalClient.Transport},
	}

	result, err := p.GenerateSummary(context.Background(), "test transcript")
	require.NoError(t, err)
	assert.Equal(t, "Meeting discussed project timelines.", result.Summary)
	assert.Equal(t, []string{"Review docs by Friday", "Schedule follow-up"}, result.ActionItems)
}

func TestOpenRouterProvider_GenerateSummary_APIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error": "invalid request"}`))
	}))
	defer server.Close()

	p := &OpenRouterProvider{
		apiKey: "test-key",
		model:  "test-model",
		client: &http.Client{
			Transport: &testTransport{server.URL, nil},
		},
	}

	result, err := p.GenerateSummary(context.Background(), "test")
	assert.Nil(t, result)
	assert.Contains(t, err.Error(), "openrouter API error")
}

func TestOpenRouterProvider_GenerateSummary_EmptyChoices(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		response := map[string]any{"choices": []any{}}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	p := &OpenRouterProvider{
		apiKey: "test-key",
		model:  "test-model",
		client: &http.Client{
			Transport: &testTransport{server.URL, nil},
		},
	}

	result, err := p.GenerateSummary(context.Background(), "test")
	assert.Nil(t, result)
	assert.Contains(t, err.Error(), "no response from AI model")
}

func TestOpenRouterProvider_GenerateSummary_InvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		response := map[string]any{
			"choices": []map[string]any{
				{"message": map[string]string{"content": "not valid json"}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	p := &OpenRouterProvider{
		apiKey: "test-key",
		model:  "test-model",
		client: &http.Client{
			Transport: &testTransport{server.URL, nil},
		},
	}

	result, err := p.GenerateSummary(context.Background(), "test")
	assert.Nil(t, result)
	assert.Contains(t, err.Error(), "parse AI response as JSON")
}

// testTransport redirects requests to the test server
type testTransport struct {
	serverURL string
	base      http.RoundTripper
}

func (t *testTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = "http"
	req.URL.Host = t.serverURL[7:] // strip "http://"
	if t.base != nil {
		return t.base.RoundTrip(req)
	}
	return http.DefaultTransport.RoundTrip(req)
}
