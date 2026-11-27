package digitalocean

import (
	"context"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

func (a *SFUWindow) expectedTags() []string {
	tags := []string{a.ownerTag, a.firewallTag}
	slices.Sort(tags)
	return tags
}

// verifyOwned pins the droplet to the exact identity this adapter creates.
// Destroy skips the image so a snapshot roll cannot strand a running node.
func (a *SFUWindow) verifyOwned(droplet sfuWindowDropletJSON, name string, checkImage bool) error {
	return a.verifyShape(droplet, name, checkImage, true)
}

func (a *SFUWindow) verifyCreateResponse(droplet sfuWindowDropletJSON, name string) error {
	return a.verifyShape(droplet, name, false, false)
}

func (a *SFUWindow) verifyShape(droplet sfuWindowDropletJSON, name string, checkImage, requireVPC bool) error {
	tags := slices.Clone(droplet.Tags)
	slices.Sort(tags)
	switch {
	case droplet.ID <= 0, droplet.Name != name, droplet.SizeSlug != SFUWindowSize, droplet.Region.Slug != a.region,
		droplet.VPCUUID != a.vpcUUID && (requireVPC || droplet.VPCUUID != ""), !slices.Equal(tags, a.expectedTags()), checkImage && droplet.Image.ID != a.snapshotID:
		return ErrSFUWindowDrift
	}
	return nil
}

func mapSFUWindowDroplet(droplet sfuWindowDropletJSON) (SFUWindowDroplet, error) {
	var address netip.Addr
	for _, network := range droplet.Networks.V4 {
		if network.Type != "public" {
			continue
		}
		parsed, err := netip.ParseAddr(network.IPAddress)
		if err != nil || !parsed.Is4() || !parsed.IsGlobalUnicast() || parsed.IsPrivate() || address.IsValid() {
			return SFUWindowDroplet{}, fmt.Errorf("%w: public IPv4 address", ErrSFUWindowDrift)
		}
		address = parsed
	}
	return SFUWindowDroplet{ID: droplet.ID, Address: address, Active: droplet.Status == "active" && address.IsValid()}, nil
}

// dropletsNamed returns every droplet whose name equals name ignoring case, so a
// case variant is surfaced to verifyOwned instead of being ignored.
func (a *SFUWindow) dropletsNamed(ctx context.Context, name string) ([]sfuWindowDropletJSON, error) {
	path := "/v2/droplets"
	query := url.Values{"per_page": {strconv.Itoa(dropletsPerPage)}, "name": {name}}
	var matches []sfuWindowDropletJSON
	for page := 0; page < sfuWindowMaxPages; page++ {
		var response struct {
			Droplets []sfuWindowDropletJSON `json:"droplets"`
			Links    struct {
				Pages struct {
					Next string `json:"next"`
				} `json:"pages"`
			} `json:"links"`
		}
		if err := a.send(ctx, http.MethodGet, path, query, nil, &response, http.StatusOK); err != nil {
			return nil, err
		}
		for _, droplet := range response.Droplets {
			if strings.EqualFold(droplet.Name, name) {
				matches = append(matches, droplet)
			}
		}
		if response.Links.Pages.Next == "" {
			return matches, nil
		}
		next, err := a.nextQuery(response.Links.Pages.Next, path)
		if err != nil {
			return nil, err
		}
		query = next
	}
	return nil, fmt.Errorf("%w: too many pages", ErrSFUWindowProvider)
}

// verifyFirewall requires FirewallID to be the one succeeded firewall that
// targets exactly FirewallTag, and no other firewall to target either window tag.
