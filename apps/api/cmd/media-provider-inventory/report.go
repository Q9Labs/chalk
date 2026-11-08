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
		return []byte(`"` + c.String() + `"`), nil
	}
	return []byte(strconv.Itoa(c.n)), nil
}

// Family is a set of cells that partition one population. Encoding sorts the keys.
type Family map[string]Cell

// draft is one family waiting to be published.
type draft struct {
	raw  counts
	keys []string
}

// publish applies the suppression rule to families that partition the same
// population, so they all sum to the same hidden total. Every cell of 1 to 4 is
// suppressed. A hidden sum could otherwise be read off another family or off the
// other cells, so if any family hides a cell, every family also hides its
// smallest remaining non-zero cell. Hidden cells then add up to an unknown
// total and none is recoverable alone, except when the hidden partner is itself
// a count near 5. No total is published.
func publish(drafts ...draft) []Family {
	families := make([]Family, len(drafts))
	anyHidden := false
	for i, d := range drafts {
		families[i] = Family{}
		for _, key := range d.keys {
			n := d.raw[key]
			hide := n > 0 && n < suppressBelow
			families[i][key] = Cell{n: n, suppressed: hide}
			anyHidden = anyHidden || hide
		}
	}
	if !anyHidden {
		return families
	}
	for i, d := range drafts {
		partner := ""
		for _, key := range d.keys {
			cell := families[i][key]
			if cell.suppressed || cell.n == 0 {
				continue
			}
			if partner == "" || cell.n < families[i][partner].n {
				partner = key
			}
		}
		if partner != "" {
			families[i][partner] = Cell{n: families[i][partner].n, suppressed: true}
		}
	}
	return families
}

func publishCell(n int) Cell {
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
	Spaces Cell   `json:"spaces"`
}

type TenantsReport struct {
	ByDefaultMediaPlane   Family `json:"by_default_media_plane"`
	ByConfigurationSource Family `json:"by_configuration_source"`
	BySpaceSelection      Family `json:"by_space_selection"`
}

type SpacesReport struct {
	Archived                 Cell   `json:"archived"`
	BySelection              Family `json:"by_selection"`
	ByNewEpisodeProvider     Family `json:"by_new_episode_provider"`
	ByConfigurationSource    Family `json:"by_configuration_source"`
	CloudflareByConfigSource Family `json:"cloudflare_by_configuration_source"`
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
	tenants := publish(
		draft{raw.Tenants.ByDefaultMediaPlane, defaultPlaneKeys},
		draft{raw.Tenants.ByConfigurationSource, configSourceKeys},
		draft{raw.Tenants.BySpaceSelection, cloudflareSpaceKeys},
	)
	spaces := publish(
		draft{raw.Spaces.BySelection, spaceSelectionKeys},
		draft{raw.Spaces.ByNewEpisodeProvider, newEpisodeKeys},
		draft{raw.Spaces.ByConfigurationSource, configSourceKeys},
		draft{raw.Spaces.CloudflareByConfigSource, configSourceKeys},
	)
	single := func(c counts) Family { return publish(draft{c, boundProviderKeys})[0] }
	return Report{
		Schema:          "chalk.media_provider_inventory.v1",
		SuppressedBelow: suppressBelow,
		Allowlist:       AllowlistReport{Mode: mode, Spaces: publishCell(len(list.spaces))},
		Tenants: TenantsReport{
			ByDefaultMediaPlane:   tenants[0],
			ByConfigurationSource: tenants[1],
			BySpaceSelection:      tenants[2],
		},
		Spaces: SpacesReport{
			Archived:                 publishCell(raw.Spaces.Archived),
			BySelection:              spaces[0],
			ByNewEpisodeProvider:     spaces[1],
			ByConfigurationSource:    spaces[2],
			CloudflareByConfigSource: spaces[3],
		},
		Episodes: EpisodesReport{
			LiveByBoundProvider:           single(raw.Episodes.LiveByBoundProvider),
			CreatedLast24hByBoundProvider: single(raw.Episodes.CreatedLast24hByBoundProvider),
		},
		Dependencies: DependencyReport{
			RecordingsByBoundProvider:            single(raw.Dependencies.RecordingsByBoundProvider),
			RecordingPipelinesInFlightByProvider: single(raw.Dependencies.RecordingPipelinesInFlightByProvider),
			TranscriptionsInFlightByProvider:     single(raw.Dependencies.TranscriptionsInFlightByProvider),
		},
	}
}

func (r Report) writeJSON(out io.Writer) error {
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(r)
}

func (r Report) writeTable(out io.Writer) error {
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
	fmt.Fprintf(table, "allowlist\t%s (%s Spaces)\n", r.Allowlist.Mode, r.Allowlist.Spaces)
	family("tenants.by_default_media_plane", r.Tenants.ByDefaultMediaPlane)
	family("tenants.by_configuration_source", r.Tenants.ByConfigurationSource)
	family("tenants.by_space_selection", r.Tenants.BySpaceSelection)
	row("spaces.archived", r.Spaces.Archived)
	family("spaces.by_selection", r.Spaces.BySelection)
	family("spaces.by_new_episode_provider", r.Spaces.ByNewEpisodeProvider)
	family("spaces.by_configuration_source", r.Spaces.ByConfigurationSource)
	family("spaces.cloudflare_by_configuration_source", r.Spaces.CloudflareByConfigSource)
	family("episodes.live_by_bound_provider", r.Episodes.LiveByBoundProvider)
	family("episodes.created_last_24h_by_bound_provider", r.Episodes.CreatedLast24hByBoundProvider)
	family("dependencies.recordings_by_bound_provider", r.Dependencies.RecordingsByBoundProvider)
	family("dependencies.recording_pipelines_in_flight_by_bound_provider", r.Dependencies.RecordingPipelinesInFlightByProvider)
	family("dependencies.transcriptions_in_flight_by_bound_provider", r.Dependencies.TranscriptionsInFlightByProvider)
	return table.Flush()
}
