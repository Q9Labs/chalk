package digitalocean

import (
	"context"
	"net/http"
	"net/url"
	"slices"
	"strconv"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func (a *RecorderFleet) findDropletsByName(ctx context.Context, name string) ([]digitalOceanDroplet, error) {
	query := url.Values{"per_page": {strconv.Itoa(dropletsPerPage)}}
	if a.gpu {
		query.Set("type", "gpus")
	} else {
		query.Set("name", name)
	}
	droplets, err := a.listDroplets(ctx, query)
	if err != nil {
		return nil, err
	}
	return slices.DeleteFunc(droplets, func(droplet digitalOceanDroplet) bool { return droplet.Name != name }), nil
}

func (a *RecorderFleet) listDroplets(ctx context.Context, query url.Values) ([]digitalOceanDroplet, error) {
	path := "/v2/droplets"
	droplets := make([]digitalOceanDroplet, 0)
	for {
		var response listDropletsResponse
		if err := a.doJSON(ctx, http.MethodGet, path, query, nil, &response, http.StatusOK); err != nil {
			return nil, err
		}
		droplets = append(droplets, response.Droplets...)
		if response.Links.Pages.Next == "" {
			return droplets, nil
		}
		next, err := url.Parse(response.Links.Pages.Next)
		if err != nil || next.Scheme != a.baseURL.Scheme || next.Host != a.baseURL.Host || next.User != nil {
			return nil, recorderfleet.ErrProviderUnavailable
		}
		path = next.Path
		query = next.Query()
	}
}

// One account-wide snapshot replaces a firewall request for every pool node.
// Keep exact per-node reads in InspectNode for bootstrap authorization.
func (a *RecorderFleet) listFirewalls(ctx context.Context) ([]digitalOceanFirewall, error) {
	path := "/v2/firewalls"
	query := url.Values{"per_page": {strconv.Itoa(dropletsPerPage)}}
	var firewalls []digitalOceanFirewall
	for {
		var response listFirewallsResponse
		if err := a.doJSON(ctx, http.MethodGet, path, query, nil, &response, http.StatusOK); err != nil {
			return nil, err
		}
		firewalls = append(firewalls, response.Firewalls...)
		if response.Links.Pages.Next == "" {
			return firewalls, nil
		}
		next, err := url.Parse(response.Links.Pages.Next)
		if err != nil || next.Scheme != a.baseURL.Scheme || next.Host != a.baseURL.Host || next.User != nil {
			return nil, recorderfleet.ErrProviderUnavailable
		}
		path, query = next.Path, next.Query()
	}
}

func (a *RecorderFleet) ensureFirewall(ctx context.Context, node recorderfleet.Node, firewallID string) (recorderfleet.Node, error) {
	if slices.Contains(node.FirewallIDs, firewallID) {
		return node, nil
	}
	providerID, err := strconv.ParseInt(node.ProviderID, 10, 64)
	if err != nil || providerID <= 0 {
		return recorderfleet.Node{}, recorderfleet.ErrInventoryDrift
	}
	payload := firewallDropletsRequest{DropletIDs: []int64{providerID}}
	if err := a.doJSON(ctx, http.MethodPost, "/v2/firewalls/"+url.PathEscape(firewallID)+"/droplets", nil, payload, nil, http.StatusNoContent); err != nil {
		return recorderfleet.Node{}, err
	}
	var response listFirewallsResponse
	if err := a.doJSON(ctx, http.MethodGet, "/v2/droplets/"+node.ProviderID+"/firewalls", nil, nil, &response, http.StatusOK); err != nil {
		return recorderfleet.Node{}, err
	}
	for _, firewall := range response.Firewalls {
		node.FirewallIDs = append(node.FirewallIDs, firewall.ID)
	}
	slices.Sort(node.FirewallIDs)
	if !slices.Contains(node.FirewallIDs, firewallID) {
		return recorderfleet.Node{}, recorderfleet.ErrInventoryDrift
	}
	return node, nil
}

func (a *RecorderFleet) ensureProject(ctx context.Context, node recorderfleet.Node) error {
	if a.projectID == "" {
		return nil
	}
	resourceURN := "do:droplet:" + node.ProviderID
	payload := projectResourcesRequest{Resources: []string{resourceURN}}
	var response projectResourcesResponse
	if err := a.doJSON(ctx, http.MethodPost, "/v2/projects/"+url.PathEscape(a.projectID)+"/resources", nil, payload, &response, http.StatusOK); err != nil {
		return err
	}
	for _, resource := range response.Resources {
		if resource.URN == resourceURN && (resource.Status == "ok" || resource.Status == "assigned" || resource.Status == "already_assigned") {
			return nil
		}
	}
	return recorderfleet.ErrInventoryDrift
}

type digitalOceanDroplet struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Status    string `json:"status"`
	SizeSlug  string `json:"size_slug"`
	CreatedAt string `json:"created_at"`
	Region    struct {
		Slug string `json:"slug"`
	} `json:"region"`
	Image struct {
		ID int64 `json:"id"`
	} `json:"image"`
	Tags     []string `json:"tags"`
	Networks struct {
		V4 []struct {
			IPAddress string `json:"ip_address"`
			Type      string `json:"type"`
		} `json:"v4"`
	} `json:"networks"`
}

type listDropletsResponse struct {
	Droplets []digitalOceanDroplet `json:"droplets"`
	Links    struct {
		Pages struct {
			Next string `json:"next"`
		} `json:"pages"`
	} `json:"links"`
}

type createDropletRequest struct {
	Name             string   `json:"name"`
	Region           string   `json:"region"`
	Size             string   `json:"size"`
	Image            int64    `json:"image"`
	Monitoring       bool     `json:"monitoring"`
	WithDropletAgent bool     `json:"with_droplet_agent"`
	Tags             []string `json:"tags"`
	UserData         string   `json:"user_data"`
	VPCUUID          string   `json:"vpc_uuid,omitempty"`
	SSHKeys          []int64  `json:"ssh_keys,omitempty"`
}

type createDropletResponse struct {
	Droplet digitalOceanDroplet `json:"droplet"`
}

type retrieveDropletResponse struct {
	Droplet digitalOceanDroplet `json:"droplet"`
}

type digitalOceanFirewall struct {
	ID         string   `json:"id"`
	DropletIDs []int64  `json:"droplet_ids"`
	Tags       []string `json:"tags"`
}

type listFirewallsResponse struct {
	Firewalls []digitalOceanFirewall `json:"firewalls"`
	Links     struct {
		Pages struct {
			Next string `json:"next"`
		} `json:"pages"`
	} `json:"links"`
}

type firewallDropletsRequest struct {
	DropletIDs []int64 `json:"droplet_ids"`
}

type projectResourcesRequest struct {
	Resources []string `json:"resources"`
}

type projectResourcesResponse struct {
	Resources []struct {
		Status string `json:"status"`
		URN    string `json:"urn"`
	} `json:"resources"`
}
