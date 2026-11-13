package recorderfleetcontrol

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func (c *Client) doJSON(ctx context.Context, method, path string, query url.Values, input, output any, expectedStatus int) error {
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: path, RawQuery: query.Encode()})
	var requestBody io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return recorderfleet.ErrInvalidConfig
		}
		requestBody = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), requestBody)
	if err != nil {
		return recorderfleet.ErrInvalidConfig
	}
	request.Header.Set("Accept", "application/json")
	if path == fleetPath+"/demand" && c.key.Role == workeridentity.RoleCapture {
		request.Header.Set("X-Chalk-Fleet-Slot-Demand", "1")
	}
	if path == fleetPath+"/nodes" {
		request.Header.Set("X-Chalk-Fleet-Lease-Observation", "1")
		request.Header.Set("X-Chalk-Fleet-Lease-Authority", "1")
	}
	if strings.HasSuffix(path, "/leases") {
		request.Header.Set("X-Chalk-Fleet-Identity-Leases", "2")
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err != nil {
		return fmt.Errorf("recorder fleet control request: %w", recorderfleet.ErrProviderUnavailable)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil || len(responseBody) > maximumResponseBytes {
		return fmt.Errorf("%w: invalid recorder fleet control response", recorderfleet.ErrProviderUnavailable)
	}
	if response.StatusCode != expectedStatus {
		if method == http.MethodPost && strings.HasSuffix(path, "/bootstrap") && response.StatusCode == http.StatusConflict {
			var failure struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
				Diagnostic *recorderfleet.BootstrapDiagnostic `json:"diagnostic,omitempty"`
			}
			if json.Unmarshal(responseBody, &failure) == nil {
				switch failure.Error.Code {
				case recorderfleet.InventoryNotReadyCode:
					return recorderfleet.ErrInventoryNotReady
				case recorderfleet.BootstrapPendingCode:
					if failure.Diagnostic != nil && failure.Diagnostic.Validate() == nil {
						return &recorderfleet.BootstrapPendingError{Diagnostic: *failure.Diagnostic}
					}
					return recorderfleet.ErrBootstrapPending
				}
			}
		}
		return fmt.Errorf("%w: recorder fleet control status %d", recorderfleet.ErrProviderUnavailable, response.StatusCode)
	}
	if path == fleetPath+"/nodes" && response.Header.Get("X-Chalk-Fleet-Lease-Authority") != "1" {
		return fmt.Errorf("%w: database lease authority is required", recorderfleet.ErrProviderUnavailable)
	}
	if strings.HasSuffix(path, "/leases") && response.Header.Get("X-Chalk-Fleet-Identity-Leases") != "2" {
		return fmt.Errorf("%w: transactionally fenced identity lease authority is required", recorderfleet.ErrProviderUnavailable)
	}
	if output == nil {
		if len(bytes.TrimSpace(responseBody)) != 0 {
			return fmt.Errorf("%w: invalid recorder fleet control response", recorderfleet.ErrProviderUnavailable)
		}
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(responseBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("%w: invalid recorder fleet control response", recorderfleet.ErrProviderUnavailable)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("%w: invalid recorder fleet control response", recorderfleet.ErrProviderUnavailable)
	}
	return nil
}

func validPathSegment(value string) bool {
	if value == "" || len(value) > 128 || strings.TrimSpace(value) != value || strings.ContainsAny(value, "/\\\r\n\x00") {
		return false
	}
	return true
}

type demandResponse struct {
	SchemaVersion string              `json:"schema_version"`
	Environment   string              `json:"environment"`
	Role          workeridentity.Role `json:"role"`
	recorderfleet.Demand
	CaptureCapacity *struct {
		SlotDemand        *int `json:"slot_demand"`
		PhysicalNodeFloor *int `json:"physical_node_floor"`
	} `json:"capture_capacity,omitempty"`
}

type nodesResponse struct {
	SchemaVersion string                          `json:"schema_version"`
	Environment   string                          `json:"environment"`
	Role          workeridentity.Role             `json:"role"`
	Nodes         []recorderfleet.NodeObservation `json:"nodes"`
}

type bootstrapRequest struct {
	SchemaVersion string `json:"schema_version"`
	recorderfleet.BootstrapRequest
}

type bootstrapResponse struct {
	SchemaVersion string                     `json:"schema_version"`
	Environment   string                     `json:"environment"`
	Role          workeridentity.Role        `json:"role"`
	Identity      recorderfleet.NodeIdentity `json:"identity"`
}

type commandRequest struct {
	SchemaVersion string                     `json:"schema_version"`
	Environment   string                     `json:"environment"`
	Identity      recorderfleet.NodeIdentity `json:"identity"`
}

type poolRequest struct {
	SchemaVersion string `json:"schema_version"`
	recorderfleet.PoolProjection
}
