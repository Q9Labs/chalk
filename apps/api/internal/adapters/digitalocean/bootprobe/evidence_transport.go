package bootprobe

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"
)

type createRequest struct {
	UserData string `json:"user_data"`
}

type auditEntry struct {
	Time                time.Time       `json:"time"`
	Method              string          `json:"method"`
	Path                string          `json:"path"`
	OriginalBody        json.RawMessage `json:"original_body,omitempty"`
	Body                json.RawMessage `json:"body,omitempty"`
	BodySHA256          string          `json:"body_sha256"`
	UserDataSHA256      string          `json:"user_data_sha256,omitempty"`
	FleetUserDataSHA256 string          `json:"fleet_user_data_sha256,omitempty"`
	Status              int             `json:"status"`
	Response            json.RawMessage `json:"response,omitempty"`
}

type evidenceTransport struct {
	next                http.RoundTripper
	path                string
	diagnosticSSHKeyID  int64
	evidenceBootCommand []string
	deadline            time.Time
}

func addDiagnosticSSHKey(body []byte, keyID int64) ([]byte, error) {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	var keys []int64
	if raw := payload["ssh_keys"]; raw != nil {
		if err := json.Unmarshal(raw, &keys); err != nil {
			return nil, err
		}
	}
	if keyID <= 0 || slices.Contains(keys, keyID) {
		return nil, errors.New("invalid diagnostic SSH key")
	}
	encoded, err := json.Marshal(append(keys, keyID))
	if err != nil {
		return nil, err
	}
	payload["ssh_keys"] = encoded
	return json.Marshal(payload)
}

// Preserve the actual bootstrap input only after the unchanged bootstrap and worker start.
func preserveEnvironment(body []byte) ([]byte, error) {
	var payload createRequest
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	cleanup := "  - [ \"/usr/bin/rm\", \"-f\", \"/etc/chalk-recorder/bootstrap.env\" ]\n"
	if !strings.HasSuffix(payload.UserData, cleanup) {
		return nil, errors.New("fleet cloud-init cleanup contract changed")
	}
	replacement := "  - [ \"/usr/bin/install\", \"-m\", \"0400\", \"/etc/chalk-recorder/bootstrap.env\", \"/etc/chalk-recorder/diagnostic-bootstrap.env\" ]\n" + cleanup
	original, err := json.Marshal(payload.UserData)
	if err != nil {
		return nil, err
	}
	updated, err := json.Marshal(strings.TrimSuffix(payload.UserData, cleanup) + replacement)
	if err != nil {
		return nil, err
	}
	if bytes.Count(body, original) != 1 {
		return nil, errors.New("ambiguous fleet cloud-init payload")
	}
	return bytes.Replace(body, original, updated, 1), nil
}

func addEvidenceBootCommand(body []byte, command []string) ([]byte, error) {
	var payload createRequest
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(payload.UserData, "#cloud-config\nwrite_files:\n") || len(command) != 3 || command[0] != "/bin/sh" || command[1] != "-c" {
		return nil, errors.New("invalid evidence cloud-init command")
	}
	encoded, err := json.Marshal(command)
	if err != nil {
		return nil, err
	}
	original, err := json.Marshal(payload.UserData)
	if err != nil {
		return nil, err
	}
	updated, err := json.Marshal(strings.Replace(payload.UserData, "#cloud-config\n", "#cloud-config\nbootcmd:\n  - "+string(encoded)+"\n", 1))
	if err != nil {
		return nil, err
	}
	if bytes.Count(body, original) != 1 {
		return nil, errors.New("ambiguous evidence cloud-init payload")
	}
	return bytes.Replace(body, original, updated, 1), nil
}

// Archive URLs are bearer credentials. Keep byte evidence without saving them.
func redactUserData(body []byte) (json.RawMessage, string, error) {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, "", err
	}
	raw, exists := payload["user_data"]
	if !exists {
		return body, "", nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, "", err
	}
	hash := sha256.Sum256([]byte(value))
	payload["user_data"] = json.RawMessage(`"[redacted; see user_data_sha256]"`)
	redacted, err := json.Marshal(payload)
	return redacted, hex.EncodeToString(hash[:]), err
}

func (t evidenceTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	var original, body []byte
	var err error
	if request.Body != nil {
		original, err = io.ReadAll(io.LimitReader(request.Body, 1<<20))
		if err != nil {
			return nil, err
		}
		if err := request.Body.Close(); err != nil {
			return nil, err
		}
		body = original
		if request.Method == http.MethodPost && request.URL.Path == "/v2/droplets" {
			body, err = preserveEnvironment(body)
			if err != nil {
				return nil, err
			}
			if t.diagnosticSSHKeyID > 0 {
				body, err = addDiagnosticSSHKey(body, t.diagnosticSSHKeyID)
				if err != nil {
					return nil, err
				}
			}
			if len(t.evidenceBootCommand) > 0 {
				body, err = addEvidenceBootCommand(body, t.evidenceBootCommand)
				if err != nil {
					return nil, err
				}
			}
		}
		request = request.Clone(request.Context())
		request.Body = io.NopCloser(bytes.NewReader(body))
		request.ContentLength = int64(len(body))
	}
	create := request.Method == http.MethodPost && request.URL.Path == "/v2/droplets"
	if create {
		if !t.deadline.IsZero() && !time.Now().Before(t.deadline) {
			return nil, errors.New("cold create deadline expired")
		}
		// A lost response must not turn a cold boot into two billable nodes.
		// Subsequent EnsureNode calls may adopt this intent but cannot POST it again.
		fence, err := os.OpenFile(t.path+".create-pending", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return nil, fmt.Errorf("cold create already submitted or fence unavailable: %w", err)
		}
		if err := fence.Close(); err != nil {
			return nil, err
		}
	}
	response, err := t.next.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if create && response.StatusCode == http.StatusUnprocessableEntity {
		// DigitalOcean can reject a newly created SSH key before it propagates.
		// A definite 422 did not allocate a node; allow the same intent to retry.
		if err := os.Remove(t.path + ".create-pending"); err != nil {
			response.Body.Close()
			return nil, err
		}
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		response.Body.Close()
		return nil, err
	}
	if err := response.Body.Close(); err != nil {
		return nil, err
	}
	response.Body = io.NopCloser(bytes.NewReader(raw))
	// Bodies only: provider Authorization headers never enter evidence.
	if request.Method != http.MethodGet {
		hash := sha256.Sum256(body)
		entry := auditEntry{Time: time.Now().UTC(), Method: request.Method, Path: request.URL.Path, OriginalBody: original, Body: body, BodySHA256: hex.EncodeToString(hash[:]), Status: response.StatusCode, Response: raw}
		if create {
			entry.OriginalBody, entry.FleetUserDataSHA256, err = redactUserData(original)
			if err != nil {
				return nil, err
			}
			entry.Body, entry.UserDataSHA256, err = redactUserData(body)
			if err != nil {
				return nil, err
			}
		}
		file, err := os.OpenFile(t.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
		if err != nil {
			return nil, err
		}
		encodeErr := json.NewEncoder(file).Encode(entry)
		closeErr := file.Close()
		if err := errors.Join(encodeErr, closeErr); err != nil {
			return nil, err
		}
	}
	return response, nil
}
