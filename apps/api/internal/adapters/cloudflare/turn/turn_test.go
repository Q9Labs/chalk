package turn

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"testing"
)

type failingClient struct{ err error }

func (f failingClient) Do(*http.Request) (*http.Response, error) { return nil, f.err }

func refusedDial(address string) error {
	return &net.OpError{Op: "dial", Net: "tcp", Addr: &net.TCPAddr{IP: net.ParseIP(address), Port: 8080}, Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
}

// A failed mint names its cause and nothing of the dial. The transport error's text holds the
// peer address, and the request URL holds the private TURN key ID.
func TestAFailedMintNamesItsCauseAndNeverThePeerAddress(t *testing.T) {
	for _, tc := range []struct{ name, address string }{{"ipv4", "203.0.113.17"}, {"ipv6", "2001:db8::1"}} {
		t.Run(tc.name, func(t *testing.T) {
			dial := refusedDial(tc.address)
			wrapped := &url.Error{Op: "Post", URL: "https://rtc.live.cloudflare.com/v1/turn/keys/secret-key-id/credentials", Err: dial}
			credentials := New("secret-key-id", "token")
			_, err := credentials.Servers(context.Background(), failingClient{err: wrapped}, defaultEndpoint)
			if err == nil || !strings.Contains(err.Error(), "request TURN credentials: transport: connection_refused") {
				t.Fatalf("mint error = %v, want the bounded cause", err)
			}
			for _, leaked := range []string{tc.address, "8080", "dial", "secret-key-id", "cloudflare.com"} {
				if strings.Contains(err.Error(), leaked) {
					t.Fatalf("mint error leaks %q: %v", leaked, err)
				}
			}
		})
	}
}
