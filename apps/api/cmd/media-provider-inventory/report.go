package main

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"text/tabwriter"
)

// suppressBelow is the smallest count printed exactly. A cell of 1 to 4 could
// single out a Tenant, so it prints as "<5". Zero is exact: it names nobody.
const suppressBelow = 5

// Cell is one published count.
type Cell struct {
	n          int
	suppressed bool
}

func (c Cell) String() string {
	if c.suppressed {
		return "<" + strconv.Itoa(suppressBelow)
	}
	return strconv.Itoa(c.n)
}

func (c Cell) MarshalJSON() ([]byte, error) {
	if c.suppressed {
		return json.Marshal(c.String())
	}
	return json.Marshal(c.n)
}

// Family is a set of cells that partition one population. Encoding sorts the keys.
type Family map[string]Cell

// publish applies the suppression rule to one family. Every cell of 1 to 4 is
// suppressed. A lone suppressed cell could be recovered as the population total
// minus the other cells, because another family of the same population shows
// that total, so the smallest remaining non-zero cell is suppressed with it.
func publish(raw counts, keys []string) Family {
	family := Family{}
	suppressed := 0
	for _, key := range keys {
		n := raw[key]
		hide := n > 0 && n < suppressBelow
		family[key] = Cell{n: n, suppressed: hide}
		if hide {
			suppressed++
		}
	}
	if suppressed != 1 {
		return family
	}
	var partner string
	for _, key := range keys {
		cell := family[key]
		if cell.suppressed || cell.n == 0 {
			continue
		}
		if partner == "" || cell.n < family[partner].n {
			partner = key
		}
	}
	if partner != "" {
		family[partner] = Cell{n: family[partner].n, suppressed: true}
	}
	return family
}

func publishTotal(n int) Cell {
	return Cell{n: n, suppressed: n > 0 && n < suppressBelow}
}

var (
	defaultPlaneKeys    = []string{"cf_sfu", "chalk_sfu", "none", "unknown"}
	configSourceKeys    = []string{"deployment_default", "tenant_chalk_managed", "tenant_managed", "disabled", "invalid"}
	spaceSelectionKeys  = []string{"space_cf_sfu", "space_chalk_sfu", "space_unknown", "tenant_default_cf_sfu", "tenant_default_chalk_sfu", "tenant_default_unknown", "none"}
	newEpisodeKeys      = []string{"chalk_sfu", "cf_sfu", "cf_sfu_by_allowlist", "none", "unresolvable"}
	cloudflareSpaceKeys = []string{"has_cloudflare_space", "no_cloudflare_space"}
	boundProviderKeys   = []string{"chalk_sfu", "cf_sfu", "legacy_cf_sfu", "none", "other", "unreadable"}
)

type Report struct {
	Schema          string           `json:"schema"`
	SuppressedBelow int              `json:"suppressed_below"`
	Allowlist       AllowlistReport  `json:"allowlist"`
	Tenants         TenantsReport    `json:"tenants"`
	Spaces          SpacesReport     `json:"spaces"`
	Episodes        EpisodesReport   `json:"episodes"`
	Dependencies    DependencyReport `json:"dependencies"`
}

// AllowlistReport states the allowlist the counts assumed: "all", "listed" or "none".
type AllowlistReport struct {
	Mode   string `json:"mode"`
	Spaces int    `json:"spaces"`
}

type TenantsReport struct {
	Total                 Cell   `json:"total"`
	ByDefaultMediaPlane   Family `json:"by_default_media_plane"`
	ByConfigurationSource Family `json:"by_configuration_source"`
	BySpaceSelection      Family `json:"by_space_selection"`
}

type SpacesReport struct {
	Total                            Cell   `json:"total"`
	Archived                         Cell   `json:"archived"`
	BySelection                      Family `json:"by_selection"`
	ByNewEpisodeProvider             Family `json:"by_new_episode_provider"`
	ByConfigurationSource            Family `json:"by_configuration_source"`
	CloudflareSelectedByConfigSource Family `json:"cloudflare_selected_by_configuration_source"`
}

type EpisodesReport struct {
	LiveByBoundProvider           Family `json:"live_by_bound_provider"`
	CreatedLast24hByBoundProvider Family `json:"created_last_24h_by_bound_provider"`
}

type DependencyReport struct {
	RecordingsByBoundProvider            Family `json:"recordings_by_bound_provider"`
	RecordingPipelinesInFlightByProvider Family `json:"recording_pipelines_in_flight_by_bound_provider"`
	TranscriptionsInFlightByProvider     Family `json:"transcriptions_in_flight_by_bound_provider"`
}

func newReport(raw rawReport, list allowlist) Report {
	mode := "none"
	switch {
	case list.all:
		mode = "all"
	case len(list.spaces) > 0:
		mode = "listed"
	}
	return Report{
		Schema:          "chalk.media_provider_inventory.v1",
		SuppressedBelow: suppressBelow,
		Allowlist:       AllowlistReport{Mode: mode, Spaces: len(list.spaces)},
		Tenants: TenantsReport{
			Total:                 publishTotal(raw.Tenants.ByConfigurationSource.total()),
			ByDefaultMediaPlane:   publish(raw.Tenants.ByDefaultMediaPlane, defaultPlaneKeys),
			ByConfigurationSource: publish(raw.Tenants.ByConfigurationSource, configSourceKeys),
			BySpaceSelection:      publish(raw.Tenants.BySpaceSelection, cloudflareSpaceKeys),
		},
		Spaces: SpacesReport{
			Total:                            publishTotal(raw.Spaces.ByConfigurationSource.total()),
			Archived:                         publishTotal(raw.Spaces.Archived),
			BySelection:                      publish(raw.Spaces.BySelection, spaceSelectionKeys),
			ByNewEpisodeProvider:             publish(raw.Spaces.ByNewEpisodeProvider, newEpisodeKeys),
			ByConfigurationSource:            publish(raw.Spaces.ByConfigurationSource, configSourceKeys),
			CloudflareSelectedByConfigSource: publish(raw.Spaces.CloudflareSelectedByConfigSource, configSourceKeys),
		},
		Episodes: EpisodesReport{
			LiveByBoundProvider:           publish(raw.Episodes.LiveByBoundProvider, boundProviderKeys),
			CreatedLast24hByBoundProvider: publish(raw.Episodes.CreatedLast24hByBoundProvider, boundProviderKeys),
		},
		Dependencies: DependencyReport{
			RecordingsByBoundProvider:            publish(raw.Dependencies.RecordingsByBoundProvider, boundProviderKeys),
			RecordingPipelinesInFlightByProvider: publish(raw.Dependencies.RecordingPipelinesInFlightByProvider, boundProviderKeys),
			TranscriptionsInFlightByProvider:     publish(raw.Dependencies.TranscriptionsInFlightByProvider, boundProviderKeys),
		},
	}
}

func (r Report) writeTable(out io.Writer) {
	table := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	row := func(name string, cell Cell) { fmt.Fprintf(table, "%s\t%s\n", name, cell) }
	family := func(name string, f Family) {
		keys := make([]string, 0, len(f))
		for key := range f {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			row(name+"."+key, f[key])
		}
	}
	fmt.Fprintf(table, "allowlist\t%s (%d Spaces)\n", r.Allowlist.Mode, r.Allowlist.Spaces)
	row("tenants.total", r.Tenants.Total)
	family("tenants.by_default_media_plane", r.Tenants.ByDefaultMediaPlane)
	family("tenants.by_configuration_source", r.Tenants.ByConfigurationSource)
	family("tenants.by_space_selection", r.Tenants.BySpaceSelection)
	row("spaces.total", r.Spaces.Total)
	row("spaces.archived", r.Spaces.Archived)
	family("spaces.by_selection", r.Spaces.BySelection)
	family("spaces.by_new_episode_provider", r.Spaces.ByNewEpisodeProvider)
	family("spaces.by_configuration_source", r.Spaces.ByConfigurationSource)
	family("spaces.cloudflare_selected_by_configuration_source", r.Spaces.CloudflareSelectedByConfigSource)
	family("episodes.live_by_bound_provider", r.Episodes.LiveByBoundProvider)
	family("episodes.created_last_24h_by_bound_provider", r.Episodes.CreatedLast24hByBoundProvider)
	family("dependencies.recordings_by_bound_provider", r.Dependencies.RecordingsByBoundProvider)
	family("dependencies.recording_pipelines_in_flight_by_bound_provider", r.Dependencies.RecordingPipelinesInFlightByProvider)
	family("dependencies.transcriptions_in_flight_by_bound_provider", r.Dependencies.TranscriptionsInFlightByProvider)
	_ = table.Flush()
}
