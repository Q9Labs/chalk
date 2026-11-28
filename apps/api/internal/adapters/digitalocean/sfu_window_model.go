package digitalocean

import (
	"strings"
)

type sfuWindowDropletJSON struct {
	digitalOceanDroplet
	VPCUUID string `json:"vpc_uuid"`
}

type sfuWindowCreateRequest struct {
	Name             string   `json:"name"`
	Region           string   `json:"region"`
	Size             string   `json:"size"`
	Image            int64    `json:"image"`
	Tags             []string `json:"tags"`
	VPCUUID          string   `json:"vpc_uuid"`
	Monitoring       bool     `json:"monitoring"`
	WithDropletAgent bool     `json:"with_droplet_agent"`
	IPv6             bool     `json:"ipv6"`
	Backups          bool     `json:"backups"`
	UserData         string   `json:"user_data,omitempty"`
}

func validSFUWindowName(name string) bool {
	id, found := strings.CutPrefix(name, sfuWindowNamePrefix)
	return found && canonicalUUID(id)
}

func canonicalUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, character := range value {
		switch {
		case index == 8 || index == 13 || index == 18 || index == 23:
			if character != '-' {
				return false
			}
		case character < '0' || character > '9' && character < 'a' || character > 'f':
			return false
		}
	}
	return true
}

func validRegionSlug(value string) bool {
	if len(value) < 4 || len(value) > 5 {
		return false
	}
	for index, character := range value {
		if index < 3 && (character < 'a' || character > 'z') || index >= 3 && (character < '0' || character > '9') {
			return false
		}
	}
	return true
}
