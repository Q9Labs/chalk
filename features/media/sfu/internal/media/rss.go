package media

import (
	"os"
	"strconv"
	"strings"
)

const rssPath = "/proc/self/statm"

// readRSS reads the process's resident memory from /proc/self/statm, whose second field is
// resident pages. It reports false where the host has no such file.
func readRSS(path string) (uint64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 2 {
		return 0, false
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return pages * uint64(os.Getpagesize()), true
}
