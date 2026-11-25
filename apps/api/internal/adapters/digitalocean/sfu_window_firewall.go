package digitalocean

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
)

func (a *SFUWindow) verifyFirewall(ctx context.Context) error {
	path := "/v2/firewalls"
	query := url.Values{"per_page": {strconv.Itoa(dropletsPerPage)}}
	found := false
	for page := 0; page < sfuWindowMaxPages; page++ {
		var response struct {
			Firewalls []struct {
				ID     string   `json:"id"`
				Status string   `json:"status"`
				Tags   []string `json:"tags"`
			} `json:"firewalls"`
			Links struct {
				Pages struct {
					Next string `json:"next"`
				} `json:"pages"`
			} `json:"links"`
		}
		if err := a.send(ctx, http.MethodGet, path, query, nil, &response, http.StatusOK); err != nil {
			return err
		}
		for _, firewall := range response.Firewalls {
			targetsWindow := slices.Contains(firewall.Tags, a.ownerTag) || slices.Contains(firewall.Tags, a.firewallTag)
			switch {
			case firewall.ID == a.firewallID:
				if firewall.Status != "succeeded" || !slices.Equal(firewall.Tags, []string{a.firewallTag}) {
					return ErrSFUWindowFirewall
				}
				found = true
			case targetsWindow:
				return ErrSFUWindowFirewall
			}
		}
		if response.Links.Pages.Next == "" {
			if !found {
				return ErrSFUWindowFirewall
			}
			return nil
		}
		next, err := a.nextQuery(response.Links.Pages.Next, path)
		if err != nil {
			return err
		}
		query = next
	}
	return fmt.Errorf("%w: too many pages", ErrSFUWindowProvider)
}
