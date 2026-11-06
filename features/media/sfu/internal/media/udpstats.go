package media

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

const udpStatsPath = "/proc/net/snmp"

// readUDPReceiveErrors reads RcvbufErrors from the Udp lines of /proc/net/snmp:
// a header line of field names, then a line of values. It reports false where
// the host has no such file or field.
func readUDPReceiveErrors(path string) (uint64, bool) {
	file, err := os.Open(path)
	if err != nil {
		return 0, false
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
		for index, name := range names {
			if name == "RcvbufErrors" && index < len(fields) {
				value, err := strconv.ParseUint(fields[index], 10, 64)
				return value, err == nil
			}
		}
		return 0, false
	}
	return 0, false
}
