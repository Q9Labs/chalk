package httpapi

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

type ClientIPOptions struct {
	TrustedProxyCIDRs []string
}

func clientIP(r *http.Request, options ClientIPOptions) string {
	remote := remoteIP(r.RemoteAddr)
	if !trustedProxy(remote, options.TrustedProxyCIDRs) {
		return remote
	}

	if ip := headerIP(r.Header.Get("CF-Connecting-IP")); ip != "" {
		return ip
	}
	if ip := firstForwardedForIP(r.Header.Get("X-Forwarded-For")); ip != "" {
		return ip
	}

	return remote
}

func trustedProxy(remote string, cidrs []string) bool {
	ip, err := netip.ParseAddr(remote)
	if err != nil {
		return false
	}

	for _, cidr := range cidrs {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(cidr))
		if err == nil && prefix.Contains(ip) {
			return true
		}
	}

	return false
}

func headerIP(value string) string {
	ip, err := netip.ParseAddr(strings.TrimSpace(value))
	if err != nil {
		return ""
	}

	return ip.String()
}

func firstForwardedForIP(header string) string {
	for _, value := range strings.Split(header, ",") {
		if ip := headerIP(value); ip != "" {
			return ip
		}
	}

	return ""
}

func remoteIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err == nil {
		return host
	}

	remoteAddr = strings.TrimSpace(remoteAddr)
	if remoteAddr == "" {
		return "unknown"
	}

	return remoteAddr
}
