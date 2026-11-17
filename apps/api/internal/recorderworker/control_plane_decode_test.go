package recorderworker

import "testing"

// A newer API may add response fields. A worker that rejected them would lease a job it can
// never start, so the decoder ignores what it does not know and still refuses trailing JSON.
func TestControlPlaneResponsesToleratedAdditiveFields(t *testing.T) {
	var response struct {
		Name string `json:"name"`
	}
	if err := decodeBoundedJSON([]byte(`{"name":"a","added_later":{"x":1}}`), &response, 1024); err != nil {
		t.Fatalf("additive field rejected: %v", err)
	}
	if response.Name != "a" {
		t.Fatalf("name %q", response.Name)
	}
	if err := decodeBoundedJSON([]byte(`{"name":"a"} {"name":"b"}`), &response, 1024); err == nil {
		t.Fatal("trailing JSON accepted")
	}
}
