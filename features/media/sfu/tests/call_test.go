package tests

import (
	"bytes"
	"encoding/json"
	"io"
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// call posts a JSON body and decodes a 2xx answer into out. It returns the status and, for
// an error answer, the protocol error code.
func (s *service) call(t *testing.T, path string, body, out any) (int, string) {
	t.Helper()
	status, problem := s.callProblem(t, path, body, out)
	return status, problem.Code
}

// callProblem is call that returns the whole error body, so a test can read its detail.
func (s *service) callProblem(t *testing.T, path string, body, out any) (int, protocol.ErrorBody) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	response, err := s.client.Post(s.baseURL+path, "application/json", bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if response.StatusCode >= 300 {
		var problem protocol.ErrorResponse
		_ = json.Unmarshal(raw, &problem)
		return response.StatusCode, problem.Error
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("decode %s: %v (%s)", path, err, raw)
		}
	}
	return response.StatusCode, protocol.ErrorBody{}
}
