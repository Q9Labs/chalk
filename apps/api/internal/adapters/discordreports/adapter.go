package discordreports

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/q9labs/chalk/apps/api/internal/problemreports"
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
		(!strings.EqualFold(destination.Hostname(), "discord.com") && !strings.EqualFold(destination.Hostname(), "discordapp.com")) ||
		(destination.Port() != "" && destination.Port() != "443") || !webhookPath.MatchString(destination.EscapedPath()) {
		return nil, errors.New("expected an HTTPS discord.com or discordapp.com webhook URL")
	}
	return &Adapter{webhookURL: webhookURL, client: &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

type discordPanel struct {
	Description string `json:"description"`
}

type discordAttachment struct {
	ID       int    `json:"id"`
	Filename string `json:"filename"`
}

type discordPayload struct {
	Attachments     []discordAttachment `json:"attachments,omitempty"`
	Content         string              `json:"content"`
	Embeds          []discordPanel      `json:"embeds,omitempty"`
	AllowedMentions struct {
		Parse []string `json:"parse"`
	} `json:"allowed_mentions"`
}

const callNameFilename = "call-name.txt"

func (c *Adapter) Send(ctx context.Context, report problemreports.Delivery) error {
	payload, attachedName := buildPayload(report)
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
	requestBody, contentType, err := encodeRequestBody(body, attachedName)
	if err != nil {
		return problemreports.ErrDelivery
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, destination.String(), requestBody)
	if err != nil {
		return problemreports.ErrDelivery
	}
	request.Header.Set("Content-Type", contentType)
	response, err := c.client.Do(request)
	// Transport errors can contain the secret webhook URL.
	if err != nil {
		return problemreports.DeliveryError{Transport: transportFailure(err)}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return problemreports.DeliveryError{HTTPStatus: response.StatusCode}
	}
	return nil
}

// buildPayload returns the message and, when the Space name cannot fit beside
// the fixed metadata, the name to attach as a file.
func buildPayload(report problemreports.Delivery) (discordPayload, string) {
	const prefix = "Chalk problem report\nCall: "
	const panelsNotice = "\n\nReport panels: description, then diagnostics when provided."
	suffix := fmt.Sprintf("\nEpisode ID: %s\nReporter: %s (%s)", report.CallID.String(), safeText(strings.Join(strings.Fields(report.ReporterName), " "), 512), report.Role)
	// Historical Space names were unbounded. Keep their full sanitized text;
	// attach names that cannot fit beside the fixed metadata in Discord content.
	name := strings.Join(strings.Fields(report.SpaceName), " ")
	name = safeText(name, len([]rune(name))*2)
	heading := prefix + name + suffix
	var attachedName string
	if utf16Length(heading+panelsNotice) > 2000 {
		attachedName = name
		heading = prefix + "See " + callNameFilename + suffix
	}
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
	var panels []discordPanel
	if utf16Length(content) > 2000 {
		content = heading + panelsNotice
		panels = append(panels, discordPanel{Description: description})
		if diagnostics != "" {
			panels = append(panels, discordPanel{Description: diagnostics})
		}
	}
	payload := discordPayload{Content: content, Embeds: panels}
	payload.AllowedMentions.Parse = []string{}
	if attachedName != "" {
		payload.Attachments = []discordAttachment{{ID: 0, Filename: callNameFilename}}
	}
	return payload, attachedName
}

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// encodeRequestBody returns the JSON body, or a multipart form that adds the
// attached Space name file, with its Content-Type.
func encodeRequestBody(body []byte, attachedName string) (*bytes.Buffer, string, error) {
	if attachedName == "" {
		return bytes.NewBuffer(body), "application/json", nil
	}
	buffer := new(bytes.Buffer)
	writer := multipart.NewWriter(buffer)
	if err := writer.WriteField("payload_json", string(body)); err != nil {
		return nil, "", err
	}
	file, err := writer.CreateFormFile("files[0]", callNameFilename)
	if err != nil {
		return nil, "", err
	}
	if _, err := file.Write([]byte(attachedName)); err != nil {
		return nil, "", err
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return buffer, writer.FormDataContentType(), nil
}

func transportFailure(err error) problemreports.TransportFailure {
	var dns *net.DNSError
	var network net.Error
	var certificate *tls.CertificateVerificationError
	var connection *net.OpError
	switch {
	case errors.Is(err, context.Canceled):
		return problemreports.TransportCanceled
	case errors.As(err, &network) && network.Timeout():
		return problemreports.TransportTimeout
	case errors.As(err, &dns):
		return problemreports.TransportDNS
	case errors.As(err, &certificate):
		return problemreports.TransportTLS
	case errors.As(err, &connection):
		return problemreports.TransportConnection
	default:
		return problemreports.TransportFailed
	}
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
