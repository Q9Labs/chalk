package tenants

import (
	"net"
	"strconv"
	"strings"
)

// The functions below canonicalize a host and port the way a browser serializes an origin.

func browserHostname(hostname string) (string, error) {
	if ip := net.ParseIP(hostname); ip != nil {
		if strings.Contains(hostname, ":") {
			return ip.String(), nil
		}
		return ip.To4().String(), nil
	}
	if ipv4, numeric := browserIPv4(hostname); numeric {
		if ipv4 == "" {
			return "", ErrInvalidCORSOrigin
		}
		return ipv4, nil
	}
	return hostname, nil
}

func browserIPv4(hostname string) (string, bool) {
	parts := strings.Split(hostname, ".")
	if len(parts) > 1 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	if len(parts) == 0 || len(parts) > 4 {
		return "", false
	}
	numbers := make([]uint64, len(parts))
	for index, part := range parts {
		number, ok := browserIPv4Number(part)
		if !ok {
			return "", false
		}
		numbers[index] = number
	}
	for _, number := range numbers[:len(numbers)-1] {
		if number > 255 {
			return "", true
		}
	}
	lastLimit := uint64(1) << uint(8*(5-len(numbers)))
	if numbers[len(numbers)-1] >= lastLimit {
		return "", true
	}
	value := numbers[len(numbers)-1]
	for index, number := range numbers[:len(numbers)-1] {
		value += number << uint(8*(3-index))
	}
	return net.IPv4(byte(value>>24), byte(value>>16), byte(value>>8), byte(value)).String(), true
}

func browserIPv4Number(value string) (uint64, bool) {
	if value == "" {
		return 0, false
	}
	base := 10
	digits := value
	if len(value) >= 2 && value[:2] == "0x" {
		base = 16
		digits = value[2:]
	} else if len(value) >= 2 && value[0] == '0' {
		base = 8
		digits = value[1:]
	}
	if digits == "" {
		return 0, true
	}
	parsed, err := strconv.ParseUint(digits, base, 32)
	return parsed, err == nil
}

func browserPort(scheme string, value string) (string, error) {
	if value == "" {
		return "", nil
	}
	port, err := strconv.ParseUint(value, 10, 16)
	if err != nil {
		return "", ErrInvalidCORSOrigin
	}
	canonical := strconv.FormatUint(port, 10)
	if (scheme == "http" && canonical == "80") || (scheme == "https" && canonical == "443") {
		return "", nil
	}
	return canonical, nil
}

func loopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
