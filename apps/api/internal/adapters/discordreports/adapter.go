package discordreports

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

type Adapter struct {
	webhookURL string
	client     *http.Client
}

func NewAdapter(webhookURL string) (*Adapter, error) {
	if webhookURL == "" {
		return nil, nil
	}
	destination, err := url.Parse(webhookURL)
	if err != nil || destination.Scheme != "https" || destination.User != nil || destination.Fragment != "" || destination.Opaque != "" ||
		(destination.Hostname() != "discord.com" && destination.Hostname() != "discordapp.com") ||
		(destination.Port() != "" && destination.Port() != "443") || !webhookPath.MatchString(destination.EscapedPath()) {
		return nil, errors.New("expected an HTTPS discord.com or discordapp.com webhook URL")
	}
	return &Adapter{webhookURL: webhookURL, client: &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *Adapter) Send(ctx context.Context, report problemreports.Delivery) error {
	const prefix = "Chalk problem report\nCall: "
	const panelsNotice = "\n\nReport panels: description, then diagnostics when provided."
	suffix := fmt.Sprintf("\nEpisode ID: %s\nReporter: %s (%s)", report.CallID.String(), safeText(strings.Join(strings.Fields(report.ReporterName), " "), 512), report.Role)
	// Each accepted name code point needs at most two UTF-16 units, including
	// Markdown escaping. The creation/rename bound therefore fits without loss.
	nameBudget := spaces.MaxNameCodePoints * 2
	heading := prefix + safeText(strings.Join(strings.Fields(report.SpaceName), " "), nameBudget) + suffix
	description := safeText(report.Description, problemreports.MaxDescriptionCodePoints*2)
	diagnostics := safeText(report.Diagnostics, problemreports.MaxDiagnosticsCodePoints*2)
	content := heading + "\n\nDescription:\n" + description
	if report.Diagnostics != "" {
		content += "\n\nDiagnostics:\n" + diagnostics
	}
	// Accepted text expands to at most two UTF-16 units per code point. Discord
	// permits 4096 units per embed description and 6000 across embeds, so the
	// 1000/2000-code-point fields fit in one message without dropping text.
	// https://docs.discord.com/developers/resources/message#embed-limits
	type panel struct {
		Description string `json:"description"`
	}
	var panels []panel
	if len(utf16.Encode([]rune(content))) > 2000 {
		content = heading + panelsNotice
		panels = append(panels, panel{Description: description})
		if diagnostics != "" {
			panels = append(panels, panel{Description: diagnostics})
		}
	}
	payload := struct {
		Content         string  `json:"content"`
		Embeds          []panel `json:"embeds,omitempty"`
		AllowedMentions struct {
			Parse []string `json:"parse"`
		} `json:"allowed_mentions"`
	}{Content: content, Embeds: panels}
	payload.AllowedMentions.Parse = []string{}
	body, err := json.Marshal(payload)
	if err != nil {
		return problemreports.ErrDelivery
	}
	destination, err := url.Parse(c.webhookURL)
	if err != nil {
		return problemreports.ErrDelivery
	}
	// Wait for Discord to acknowledge the created message.
	query := destination.Query()
	query.Set("wait", "true")
	destination.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, destination.String(), bytes.NewReader(body))
	if err != nil {
		return problemreports.ErrDelivery
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.client.Do(request)
	// Transport errors can contain the secret webhook URL.
	if err != nil {
		category := problemreports.TransportFailed
		var dns *net.DNSError
		var network net.Error
		var certificate *tls.CertificateVerificationError
		var connection *net.OpError
		switch {
		case errors.Is(err, context.Canceled):
			category = problemreports.TransportCanceled
		case errors.As(err, &network) && network.Timeout():
			category = problemreports.TransportTimeout
		case errors.As(err, &dns):
			category = problemreports.TransportDNS
		case errors.As(err, &certificate):
			category = problemreports.TransportTLS
		case errors.As(err, &connection):
			category = problemreports.TransportConnection
		}
		return problemreports.DeliveryError{Transport: category}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return problemreports.DeliveryError{HTTPStatus: response.StatusCode}
	}
	return nil
}

var webhookPath = regexp.MustCompile(`^/api(?:/v[0-9]+)?/webhooks/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$`)

// Only explicit URLs are links; source-file positions and bare hosts are text.
var explicitURL = regexp.MustCompile("(?i)(?:https?://|www\\.)[^\\s<>`]+")
var markdown = strings.NewReplacer("\\", "\\\\", "`", "\\`", "<", "\\<", ">", "\\>", "*", "\\*", "_", "\\_", "~", "\\~", "|", "\\|", "[", "\\[", "]", "\\]", "(", "\\(", ")", "\\)", "#", "\\#")

func safeText(value string, limit int) string {
	var literal strings.Builder
	start := 0
	for _, match := range explicitURL.FindAllStringIndex(value, -1) {
		literal.WriteString(markdown.Replace(value[start:match[0]]))
		link := value[match[0]:match[1]]
		// Keep surrounding prose/Markdown punctuation outside the code span.
		link = strings.TrimRight(link, ").,;!]}\"'")
		end := match[0] + len(link)
		if query := strings.IndexAny(link, "?#"); query >= 0 {
			link = link[:query]
		}
		// Inline code displays the URL without Discord auto-linking it.
		literal.WriteString("`" + link + "`")
		literal.WriteString(markdown.Replace(value[end:match[1]]))
		start = match[1]
	}
	literal.WriteString(markdown.Replace(value[start:]))
	value = literal.String()
	units, inCode, escaped := 0, false, false
	for index, char := range value {
		units += utf16.RuneLen(char)
		if units > limit {
			ending := "…"
			if inCode {
				ending += "`"
			}
			return value[:index] + ending
		}
		if char == '`' && !escaped {
			inCode = !inCode
		}
		if !inCode && char == '\\' && !escaped {
			escaped = true
		} else {
			escaped = false
		}
	}
	return value
}
