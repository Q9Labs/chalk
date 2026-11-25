package render

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
)

// RunPageChild is the isolated PDFium process entrypoint. The parent passes
// input, output prefix, page and target edge as arguments.
func RunPageChild(args []string) int {
	if len(args) != 4 {
		fmt.Fprintln(os.Stderr, "render page child expects input, output prefix, page and target edge")
		return 2
	}
	input, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	page, err := strconv.Atoi(args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	target, err := strconv.Atoi(args[3])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	bitmap, width, height, _, err := RenderPDFPage(input, page, target)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := os.WriteFile(args[1]+".raw", bitmap, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	metadata, _ := json.Marshal(map[string]int{"width": width, "height": height})
	if err := os.WriteFile(args[1]+".json", metadata, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
