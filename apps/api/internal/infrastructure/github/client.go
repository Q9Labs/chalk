package github

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Client handles GitHub API interactions
type Client struct {
	token      string
	owner      string
	repo       string
	httpClient *http.Client
}

// ReleaseType indicates the semantic version change type
type ReleaseType string

const (
	ReleaseTypeMajor ReleaseType = "major"
	ReleaseTypeMinor ReleaseType = "minor"
	ReleaseTypePatch ReleaseType = "patch"
)

// Release represents a GitHub release with parsed what's new content
type Release struct {
	Version     string      `json:"version"`
	PublishedAt time.Time   `json:"published_at"`
	Title       string      `json:"title"`
	Content     string      `json:"content"`
	ImageKey    string      `json:"image_key,omitempty"`
	ReleaseType ReleaseType `json:"release_type,omitempty"`
	HasWhatsNew bool        `json:"-"` // true if release has <!-- whats-new --> tags
}

// githubRelease is the raw GitHub API response
type githubRelease struct {
	TagName     string    `json:"tag_name"`
	Name        string    `json:"name"`
	Body        string    `json:"body"`
	PublishedAt time.Time `json:"published_at"`
}

// NewClient creates a new GitHub API client
func NewClient(token, owner, repo string) *Client {
	return &Client{
		token:      token,
		owner:      owner,
		repo:       repo,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// GetLatestRelease fetches the latest release and parses what's new content
func (c *Client) GetLatestRelease(ctx context.Context) (*Release, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/latest", c.owner, c.repo)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch release: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNoRelease
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("github API error (status %d): %s", resp.StatusCode, string(body))
	}

	var ghRelease githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&ghRelease); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return c.parseRelease(&ghRelease), nil
}

// parseRelease extracts what's new content from the release body
func (c *Client) parseRelease(gh *githubRelease) *Release {
	version := strings.TrimPrefix(gh.TagName, "v")
	title := cleanTitle(gh.Name, version)

	release := &Release{
		Version:     version,
		PublishedAt: gh.PublishedAt,
		Title:       title,
	}

	// Extract image key: <!-- image: whats-new/v1.2.0/hero.png -->
	imageRe := regexp.MustCompile(`<!--\s*image:\s*([^\s]+)\s*-->`)
	if matches := imageRe.FindStringSubmatch(gh.Body); len(matches) > 1 {
		release.ImageKey = matches[1]
	}

	// Extract content between <!-- whats-new --> and <!-- /whats-new -->
	contentRe := regexp.MustCompile(`(?s)<!--\s*whats-new\s*-->(.*?)<!--\s*/whats-new\s*-->`)
	if matches := contentRe.FindStringSubmatch(gh.Body); len(matches) > 1 {
		release.Content = strings.TrimSpace(matches[1])
		release.HasWhatsNew = true
	}
	// No fallback - releases without whats-new tags will have empty content

	return release
}

// ErrNoRelease indicates no releases exist
var ErrNoRelease = fmt.Errorf("no releases found")

// cleanTitle removes version prefix from title if present
// e.g. "v0.0.41 - Vox Populi" -> "Vox Populi"
func cleanTitle(name, version string) string {
	name = strings.TrimSpace(name)

	// Try various version prefix patterns
	prefixes := []string{
		"v" + version + " - ",
		"v" + version + "-",
		"v" + version + ": ",
		"v" + version + " ",
		version + " - ",
		version + "-",
		version + ": ",
		version + " ",
	}

	for _, prefix := range prefixes {
		if strings.HasPrefix(name, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(name, prefix))
		}
	}

	return name
}

// GetReleases fetches multiple releases and parses what's new content
func (c *Client) GetReleases(ctx context.Context, limit int) ([]*Release, error) {
	if limit <= 0 {
		limit = 10
	}

	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases?per_page=%d", c.owner, c.repo, limit)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch releases: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNoRelease
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("github API error (status %d): %s", resp.StatusCode, string(body))
	}

	var ghReleases []githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&ghReleases); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if len(ghReleases) == 0 {
		return nil, ErrNoRelease
	}

	releases := make([]*Release, 0, len(ghReleases))
	for i := range ghReleases {
		release := c.parseRelease(&ghReleases[i])
		releases = append(releases, release)
	}

	// Derive release types by comparing consecutive versions
	for i := range releases {
		if i < len(releases)-1 {
			releases[i].ReleaseType = compareVersions(releases[i].Version, releases[i+1].Version)
		} else {
			// Last release (oldest) - assume patch or derive from version
			releases[i].ReleaseType = deriveReleaseType(releases[i].Version)
		}
	}

	return releases, nil
}

// semver holds parsed semantic version components
type semver struct {
	major int
	minor int
	patch int
}

// parseSemver extracts major.minor.patch from a version string
func parseSemver(version string) semver {
	// Remove leading 'v' if present
	version = strings.TrimPrefix(version, "v")

	var s semver
	parts := strings.Split(version, ".")

	if len(parts) >= 1 {
		_, _ = fmt.Sscanf(parts[0], "%d", &s.major)
	}
	if len(parts) >= 2 {
		_, _ = fmt.Sscanf(parts[1], "%d", &s.minor)
	}
	if len(parts) >= 3 {
		// Handle pre-release suffixes like "1.2.3-beta"
		patchPart := strings.Split(parts[2], "-")[0]
		_, _ = fmt.Sscanf(patchPart, "%d", &s.patch)
	}

	return s
}

// compareVersions determines the release type by comparing current to previous version
func compareVersions(current, previous string) ReleaseType {
	curr := parseSemver(current)
	prev := parseSemver(previous)

	if curr.major > prev.major {
		return ReleaseTypeMajor
	}
	if curr.minor > prev.minor {
		return ReleaseTypeMinor
	}
	return ReleaseTypePatch
}

// deriveReleaseType determines release type from version alone (for oldest release)
func deriveReleaseType(version string) ReleaseType {
	s := parseSemver(version)

	// If minor and patch are 0, it's a major release
	if s.minor == 0 && s.patch == 0 {
		return ReleaseTypeMajor
	}
	// If patch is 0, it's a minor release
	if s.patch == 0 {
		return ReleaseTypeMinor
	}
	return ReleaseTypePatch
}
