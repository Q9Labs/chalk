package digitalocean

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func (a *RecorderFleet) DeleteNode(ctx context.Context, request recorderfleet.DeleteNodeRequest) error {
	providerID, err := strconv.ParseInt(request.ProviderID, 10, 64)
	if err != nil || providerID <= 0 || strings.TrimSpace(request.Name) == "" || len(request.RequiredTags) == 0 {
		return recorderfleet.ErrInventoryDrift
	}
	var response retrieveDropletResponse
	err = a.doJSON(ctx, http.MethodGet, "/v2/droplets/"+strconv.FormatInt(providerID, 10), nil, nil, &response, http.StatusOK)
	if errors.Is(err, errNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if response.Droplet.Name != request.Name || !slices.Contains(response.Droplet.Tags, a.ownerTag) || !slices.Contains(response.Droplet.Tags, recorderfleet.EnvironmentTag(a.environment)) || !slices.Contains(response.Droplet.Tags, recorderfleet.RoleTag(a.role)) {
		return recorderfleet.ErrInventoryDrift
	}
	for _, tag := range request.RequiredTags {
		if !slices.Contains(response.Droplet.Tags, tag) {
			return recorderfleet.ErrInventoryDrift
		}
	}
	if !request.EvidenceUntil.IsZero() {
		if a.now().Before(request.EvidenceUntil) {
			if err := a.ensureBootstrapEvidence(ctx, response.Droplet); err != nil {
				return err
			}
		} else {
			slog.WarnContext(ctx, "recorder bootstrap evidence deadline elapsed",
				"event", "recorder.bootstrap_evidence_skipped",
				"provider_id", request.ProviderID,
				"node_name", request.Name,
				"reason", "deadline",
			)
		}
	}
	return a.doJSON(ctx, http.MethodDelete, "/v2/droplets/"+strconv.FormatInt(providerID, 10), nil, nil, nil, http.StatusNoContent)
}

func (a *RecorderFleet) validateKey(key recorderfleet.PoolKey) error {
	if a == nil || key.Environment != a.environment || key.Role != a.role {
		return recorderfleet.ErrRoleFence
	}
	return key.Validate()
}

func (a *RecorderFleet) mapNode(ctx context.Context, droplet digitalOceanDroplet, includeFirewalls bool) (recorderfleet.Node, error) {
	createdAt, _ := time.Parse(time.RFC3339, droplet.CreatedAt)
	node := recorderfleet.Node{
		ProviderID: strconv.FormatInt(droplet.ID, 10), Name: droplet.Name, Status: droplet.Status,
		Region: droplet.Region.Slug, Size: droplet.SizeSlug, ImageID: droplet.Image.ID,
		Tags: append([]string(nil), droplet.Tags...), BootGeneration: bootGeneration(droplet.Tags), CreatedAt: createdAt,
	}
	if !includeFirewalls {
		return node, nil
	}
	var response listFirewallsResponse
	if err := a.doJSON(ctx, http.MethodGet, "/v2/droplets/"+node.ProviderID+"/firewalls", nil, nil, &response, http.StatusOK); err != nil {
		return recorderfleet.Node{}, err
	}
	node.FirewallIDs = node.FirewallIDs[:0]
	for _, firewall := range response.Firewalls {
		node.FirewallIDs = append(node.FirewallIDs, firewall.ID)
	}
	slices.Sort(node.FirewallIDs)
	return node, nil
}

func nodeMatchesEnsure(node recorderfleet.Node, request recorderfleet.EnsureNodeRequest, requireFirewall bool) bool {
	if node.Name != request.Name || node.Region != request.Release.Region || node.Size != request.Release.Size || node.ImageID != request.Release.ImageID || node.BootGeneration != request.BootGeneration {
		return false
	}
	for _, tag := range request.RequiredTags {
		if !slices.Contains(node.Tags, tag) {
			return false
		}
	}
	return !requireFirewall || slices.Contains(node.FirewallIDs, request.Release.FirewallID)
}

func bootGeneration(tags []string) uint64 {
	var generation uint64
	for _, tag := range tags {
		value, found := strings.CutPrefix(tag, "chalk-boot-")
		if !found {
			continue
		}
		parsed, err := strconv.ParseUint(value, 10, 64)
		if err != nil || parsed == 0 || generation != 0 {
			return 0
		}
		generation = parsed
	}
	return generation
}
