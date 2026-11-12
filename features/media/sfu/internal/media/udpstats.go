package media

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

const udpStatsPath = "/proc/net/snmp"

// udpErrors are the host's cumulative counts of UDP datagrams dropped because a socket buffer
// was full, since boot.
type udpErrors struct{ receive, send uint64 }

// readUDPErrors reads RcvbufErrors and SndbufErrors from the Udp lines of /proc/net/snmp: a
// header line of field names, then a line of values. It reports false where the host has no
// such file or field.
func readUDPErrors(path string) (udpErrors, bool) {
	file, err := os.Open(path)
	if err != nil {
		return udpErrors{}, false
	}
	defer func() { _ = file.Close() }()
	var names []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 || fields[0] != "Udp:" {
			continue
		}
		if names == nil {
			names = fields
			continue
		}
		return udpErrorsOf(names, fields)
	}
	return udpErrors{}, false
}

// udpErrorsOf picks the receive and send buffer error counters out of a row of values, by the
// header row's field names. It reports false when either is missing.
func udpErrorsOf(names, fields []string) (udpErrors, bool) {
	var errs udpErrors
	found := 0
	for index, name := range names {
		if index >= len(fields) {
			break
		}
		switch name {
		case "RcvbufErrors":
			errs.receive = parseCounter(fields[index], &found)
		case "SndbufErrors":
			errs.send = parseCounter(fields[index], &found)
		}
	}
	return errs, found == 2
}

func parseCounter(field string, found *int) uint64 {
	value, err := strconv.ParseUint(field, 10, 64)
	if err == nil {
		*found++
	}
	return value
}
