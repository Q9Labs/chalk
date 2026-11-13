package digitalocean

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func (a *RecorderFleet) ensureBootstrapEvidence(ctx context.Context, droplet digitalOceanDroplet) error {
	snapshotName := droplet.Name + "-bootstrap-evidence"
	snapshots, err := a.listDropletSnapshots(ctx, droplet.ID)
	if err != nil {
		a.logBootstrapEvidenceError(ctx, droplet, "list_droplet_snapshots", err)
		return recorderfleet.ErrNodeEvidencePending
	}
	for _, snapshot := range snapshots {
		if snapshot.Name == snapshotName {
			if snapshot.ID == "" {
				a.logBootstrapEvidenceError(ctx, droplet, "list_droplet_snapshots", errors.New("snapshot ID missing"))
				return recorderfleet.ErrNodeEvidencePending
			}
			a.pruneBootstrapEvidence(ctx, droplet, snapshot.ID)
			slog.InfoContext(ctx, "recorder bootstrap evidence preserved",
				"event", "recorder.bootstrap_evidence_preserved",
				"provider_id", strconv.FormatInt(droplet.ID, 10),
				"node_name", droplet.Name,
				"snapshot_id", string(snapshot.ID),
			)
			return nil
		}
	}

	actions, err := a.listDropletActions(ctx, droplet.ID)
	if err != nil {
		a.logBootstrapEvidenceError(ctx, droplet, "list_droplet_actions", err)
		return recorderfleet.ErrNodeEvidencePending
	}
	for _, action := range actions {
		if action.Type == "snapshot" && action.Status == "in-progress" {
			return recorderfleet.ErrNodeEvidencePending
		}
	}

	input := struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}{Type: "snapshot", Name: snapshotName}
	path := "/v2/droplets/" + strconv.FormatInt(droplet.ID, 10) + "/actions"
	if err := a.doJSON(ctx, http.MethodPost, path, nil, input, nil, http.StatusCreated); err != nil {
		a.logBootstrapEvidenceError(ctx, droplet, "create_snapshot", err)
		return recorderfleet.ErrNodeEvidencePending
	}
	return recorderfleet.ErrNodeEvidencePending
}

func (a *RecorderFleet) listDropletSnapshots(ctx context.Context, dropletID int64) ([]digitalOceanSnapshot, error) {
	path := "/v2/droplets/" + strconv.FormatInt(dropletID, 10) + "/snapshots"
	query := url.Values{"per_page": {strconv.Itoa(dropletsPerPage)}}
	snapshots := make([]digitalOceanSnapshot, 0)
	for {
		var response listSnapshotsResponse
		if err := a.doJSON(ctx, http.MethodGet, path, query, nil, &response, http.StatusOK); err != nil {
			return nil, err
		}
		snapshots = append(snapshots, response.Snapshots...)
		if response.Links.Pages.Next == "" {
			return snapshots, nil
		}
		nextQuery, err := a.snapshotNextPage(response.Links.Pages.Next, path)
		if err != nil {
			return nil, err
		}
		query = nextQuery
	}
}

func (a *RecorderFleet) listDropletActions(ctx context.Context, dropletID int64) ([]digitalOceanAction, error) {
	path := "/v2/droplets/" + strconv.FormatInt(dropletID, 10) + "/actions"
	var response listActionsResponse
	err := a.doJSON(ctx, http.MethodGet, path, url.Values{"per_page": {strconv.Itoa(dropletsPerPage)}}, nil, &response, http.StatusOK)
	return response.Actions, err
}

func (a *RecorderFleet) pruneBootstrapEvidence(ctx context.Context, droplet digitalOceanDroplet, currentSnapshotID snapshotID) {
	snapshots, err := a.listSnapshots(ctx)
	if err != nil {
		a.logBootstrapEvidenceError(ctx, droplet, "prune_list_snapshots", err)
		return
	}
	prefix := "chalk-recorder-" + string(a.role) + "-" + a.environment + "-"
	owned := make([]digitalOceanSnapshot, 0)
	for _, snapshot := range snapshots {
		if snapshot.ID != currentSnapshotID && snapshot.ID != "" && snapshot.ResourceType == "droplet" &&
			strings.HasPrefix(snapshot.Name, prefix) && strings.HasSuffix(snapshot.Name, "-bootstrap-evidence") {
			owned = append(owned, snapshot)
		}
	}
	slices.SortFunc(owned, compareSnapshotCreatedAt)
	if len(owned) <= 2 {
		return
	}
	for _, snapshot := range owned[2:] {
		path := "/v2/snapshots/" + string(snapshot.ID)
		if err := a.doJSON(ctx, http.MethodDelete, path, nil, nil, nil, http.StatusNoContent); err != nil {
			a.logBootstrapEvidenceError(ctx, droplet, "prune_delete_snapshot", err)
		}
	}
}

func (a *RecorderFleet) listSnapshots(ctx context.Context) ([]digitalOceanSnapshot, error) {
	path := "/v2/snapshots"
	query := url.Values{"per_page": {strconv.Itoa(dropletsPerPage)}, "resource_type": {"droplet"}}
	snapshots := make([]digitalOceanSnapshot, 0)
	for {
		var response listSnapshotsResponse
		if err := a.doJSON(ctx, http.MethodGet, path, query, nil, &response, http.StatusOK); err != nil {
			return nil, err
		}
		snapshots = append(snapshots, response.Snapshots...)
		if response.Links.Pages.Next == "" {
			return snapshots, nil
		}
		nextQuery, err := a.snapshotNextPage(response.Links.Pages.Next, path)
		if err != nil {
			return nil, err
		}
		query = nextQuery
	}
}

func (a *RecorderFleet) snapshotNextPage(next, expectedPath string) (url.Values, error) {
	parsed, err := url.Parse(next)
	if err != nil || parsed.Scheme != a.baseURL.Scheme || parsed.Host != a.baseURL.Host ||
		parsed.User != nil || parsed.Fragment != "" || parsed.Path != expectedPath {
		return nil, recorderfleet.ErrProviderUnavailable
	}
	return parsed.Query(), nil
}

func (a *RecorderFleet) logBootstrapEvidenceError(ctx context.Context, droplet digitalOceanDroplet, operation string, err error) {
	status := 0
	var statusError *digitalOceanHTTPStatusError
	if errors.As(err, &statusError) {
		status = statusError.status
	}
	slog.WarnContext(ctx, "recorder bootstrap evidence operation failed",
		"event", "recorder.bootstrap_evidence_pending",
		"provider_id", strconv.FormatInt(droplet.ID, 10),
		"node_name", droplet.Name,
		"operation", operation,
		"http_status", status,
	)
}

type digitalOceanSnapshot struct {
	ID           snapshotID `json:"id"`
	Name         string     `json:"name"`
	CreatedAt    string     `json:"created_at"`
	ResourceType string     `json:"resource_type"`
}

type snapshotID string

func (id *snapshotID) UnmarshalJSON(data []byte) error {
	var value string
	if len(data) > 0 && data[0] == '"' {
		if err := json.Unmarshal(data, &value); err != nil {
			return err
		}
	} else {
		value = string(data)
	}
	if value == "" {
		return errors.New("invalid DigitalOcean snapshot ID")
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return errors.New("invalid DigitalOcean snapshot ID")
		}
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return errors.New("invalid DigitalOcean snapshot ID")
	}
	*id = snapshotID(strconv.FormatUint(parsed, 10))
	return nil
}

type listSnapshotsResponse struct {
	Snapshots []digitalOceanSnapshot `json:"snapshots"`
	Links     struct {
		Pages struct {
			Next string `json:"next"`
		} `json:"pages"`
	} `json:"links"`
}

type digitalOceanAction struct {
	Type   string `json:"type"`
	Status string `json:"status"`
}

type listActionsResponse struct {
	Actions []digitalOceanAction `json:"actions"`
}

func compareSnapshotCreatedAt(left, right digitalOceanSnapshot) int {
	leftTime, _ := time.Parse(time.RFC3339Nano, left.CreatedAt)
	rightTime, _ := time.Parse(time.RFC3339Nano, right.CreatedAt)
	if leftTime.After(rightTime) {
		return -1
	}
	if leftTime.Before(rightTime) {
		return 1
	}
	if len(left.ID) > len(right.ID) {
		return -1
	}
	if len(left.ID) < len(right.ID) {
		return 1
	}
	if left.ID > right.ID {
		return -1
	}
	if left.ID < right.ID {
		return 1
	}
	return 0
}
