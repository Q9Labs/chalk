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

// Release represents a GitHub release with parsed what's new content
type Release struct {
	Version     string    `json:"version"`
	PublishedAt time.Time `json:"published_at"`
	Title       string    `json:"title"`
	Content     string    `json:"content"`
	ImageKey    string    `json:"image_key,omitempty"`
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
	release := &Release{
		Version:     strings.TrimPrefix(gh.TagName, "v"),
		PublishedAt: gh.PublishedAt,
		Title:       gh.Name,
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
	} else {
		// Fallback: use entire body if no tags found
		release.Content = gh.Body
	}

	return release
}

// ErrNoRelease indicates no releases exist
var ErrNoRelease = fmt.Errorf("no releases found")
