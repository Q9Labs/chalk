package turn

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// scriptedClient answers each request from a list: nil serves a credential, an error fails it.
// The last answer repeats.
type scriptedClient struct {
	answers []error
	calls   int
}

func (c *scriptedClient) Do(*http.Request) (*http.Response, error) {
	answer := c.answers[min(c.calls, len(c.answers)-1)]
	c.calls++
	if answer != nil {
		return nil, answer
	}
	body := `{"iceServers":[{"urls":["turn:turn.example.test:3478?transport=udp"],"username":"u","credential":"c"}]}`
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
}

// clockedCredentials is a Credentials whose clock the test moves.
func clockedCredentials() (*Credentials, *time.Time) {
	now := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
	credentials := New("key", "token")
	credentials.now = func() time.Time { return now }
	return credentials, &now
}

func TestAMintRefusedOnceIsRetriedBeforeTheJoinGivesUp(t *testing.T) {
	credentials, _ := clockedCredentials()
	client := &scriptedClient{answers: []error{refusedDial("203.0.113.17"), nil}}
	servers, err := credentials.Servers(context.Background(), client, defaultEndpoint)
	if err != nil || len(servers) == 0 || client.calls != 2 {
		t.Fatalf("servers %v, error %v after %d calls, want TURN servers from the second call", servers, err, client.calls)
	}
}

func TestAFailedRefreshKeepsServingACredentialThatStillHasLife(t *testing.T) {
	credentials, now := clockedCredentials()
	client := &scriptedClient{answers: []error{nil, refusedDial("203.0.113.17")}}
	if _, err := credentials.Servers(context.Background(), client, defaultEndpoint); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(turnCredentialReuse + time.Minute)
	servers, err := credentials.Servers(context.Background(), client, defaultEndpoint)
	if err != nil || len(servers) == 0 {
		t.Fatalf("servers %v, error %v, want the earlier credential while the refresh fails", servers, err)
	}
}

func TestACredentialNearItsEndIsNotServedAfterAFailedRefresh(t *testing.T) {
	credentials, now := clockedCredentials()
	client := &scriptedClient{answers: []error{nil, refusedDial("203.0.113.17")}}
	if _, err := credentials.Servers(context.Background(), client, defaultEndpoint); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(turnStaleLife + time.Minute)
	if servers, err := credentials.Servers(context.Background(), client, defaultEndpoint); err == nil {
		t.Fatalf("served %v, want the failure once the credential has under an hour left", servers)
	}
}

func TestAFailedMintBlocksJoinsForFiveSecondsAndThenMintsAgain(t *testing.T) {
	credentials, now := clockedCredentials()
	client := &scriptedClient{answers: []error{refusedDial("203.0.113.17"), refusedDial("203.0.113.17"), nil}}
	if _, err := credentials.Servers(context.Background(), client, defaultEndpoint); err == nil {
		t.Fatal("a mint that failed twice returned servers")
	}
	*now = now.Add(turnMintBackoff - time.Second)
	if _, err := credentials.Servers(context.Background(), client, defaultEndpoint); err == nil || client.calls != 2 {
		t.Fatalf("error %v after %d calls, want the backoff to answer without a call", err, client.calls)
	}
	*now = now.Add(2 * time.Second)
	if servers, err := credentials.Servers(context.Background(), client, defaultEndpoint); err != nil || len(servers) == 0 {
		t.Fatalf("servers %v, error %v, want a new mint after the backoff", servers, err)
	}
}
