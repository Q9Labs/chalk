package render

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"strconv"
	"time"

	_ "golang.org/x/image/webp"
)

const maxImagePixels = 16_000_000

type inventoryPage struct {
	Page   int `json:"page"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// RunChild is the isolated untrusted-file process entrypoint. It must apply
// its resource limits before opening input: the parent cannot interrupt a
// native PDFium call, so CPU, address-space, output and wall-clock bounds are
// all enforced around this process.
func RunChild(mode string, args []string) int {
	applyChildRlimits()
	switch mode {
	case "inventory":
		return runInventoryChild(args)
	case "page":
		return runPageChild(args)
	case "image":
		return runImageChild(args)
	default:
		fmt.Fprintln(os.Stderr, "unknown renderer child mode")
		return 2
	}
}

// RunPageChild keeps the original benchmark entrypoint. Production uses
// RunChild("page", ...) through RENDER_CHILD_MODE.
func RunPageChild(args []string) int {
	applyChildRlimits()
	return runPageChild(args)
}

func runInventoryChild(args []string) int {
	started := time.Now()
	var timing ChildTiming
	if len(args) != 3 {
		fmt.Fprintln(os.Stderr, "inventory child expects input, output prefix and mime type")
		return 2
	}
	readStarted := time.Now()
	input, err := os.ReadFile(args[0])
	timing.InputReadMs = time.Since(readStarted).Milliseconds()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if args[2] == "application/pdf" {
		inventory, pdfTiming, _, err := PDFInventoryFromBytesTimed(input)
		mergeTiming(&timing, pdfTiming)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		pages := make([]inventoryPage, 0, len(inventory.Pages))
		for index, page := range inventory.Pages {
			pages = append(pages, inventoryPage{Page: index + 1, Width: page.Width, Height: page.Height})
		}
		if !writeJSON(args[1]+".inventory", pages) {
			return 1
		}
	} else {
		width, height, err := imageDimensionsBounded(input)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		width, height = ScaledDimensions(width, height, 1600)
		if !writeJSON(args[1]+".inventory", []inventoryPage{{Page: 1, Width: width, Height: height}}) {
			return 1
		}
	}
	timing.TotalMs = time.Since(started).Milliseconds()
	writeTiming(args[1], timing)
	return 0
}

func runPageChild(args []string) int {
	started := time.Now()
	var timing ChildTiming
	if len(args) != 4 {
		fmt.Fprintln(os.Stderr, "render page child expects input, output prefix, page and target edge")
		return 2
	}
	readStarted := time.Now()
	input, err := os.ReadFile(args[0])
	timing.InputReadMs = time.Since(readStarted).Milliseconds()
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
	bitmap, width, height, pdfTiming, _, err := RenderPDFPageTimed(input, page, target)
	mergeTiming(&timing, pdfTiming)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	writeStarted := time.Now()
	result := writeBitmap(args[1], bitmap, width, height)
	timing.BitmapWriteMs = time.Since(writeStarted).Milliseconds()
	timing.TotalMs = time.Since(started).Milliseconds()
	writeTiming(args[1], timing)
	return result
}

func runImageChild(args []string) int {
	if len(args) != 2 {
		fmt.Fprintln(os.Stderr, "image child expects input and output prefix")
		return 2
	}
	input, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	bitmap, width, height, err := DecodeImageBGRABounded(input)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return writeBitmap(args[1], bitmap, width, height)
}

func imageDimensionsBounded(input []byte) (int, int, error) {
	config, _, err := image.DecodeConfig(bytes.NewReader(input))
	if err != nil {
		return 0, 0, err
	}
	if config.Width < 1 || config.Height < 1 || config.Width > 12000 || config.Height > 12000 || config.Width*config.Height > maxImagePixels {
		return 0, 0, fmt.Errorf("image dimensions %dx%d exceed renderer bounds", config.Width, config.Height)
	}
	return config.Width, config.Height, nil
}

// DecodeImageBGRABounded checks dimensions and total pixels before allocating
// the decoded image or output bitmap.
func DecodeImageBGRABounded(input []byte) ([]byte, int, int, error) {
	width, height, err := imageDimensionsBounded(input)
	if err != nil {
		return nil, 0, 0, err
	}
	decoded, _, err := image.Decode(bytes.NewReader(input))
	if err != nil {
		return nil, 0, 0, err
	}
	bounds := decoded.Bounds()
	if bounds.Dx() != width || bounds.Dy() != height {
		return nil, 0, 0, fmt.Errorf("image dimensions changed during decode")
	}
	output := make([]byte, width*height*4)
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			r, g, b, a := decoded.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			offset := (y*width + x) * 4
			output[offset] = byte(b >> 8)
			output[offset+1] = byte(g >> 8)
			output[offset+2] = byte(r >> 8)
			output[offset+3] = byte(a >> 8)
		}
	}
	return output, width, height, nil
}

func writeBitmap(prefix string, bitmap []byte, width, height int) int {
	if err := os.WriteFile(prefix+".raw", bitmap, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if !writeJSON(prefix+".json", map[string]int{"width": width, "height": height}) {
		return 1
	}
	return 0
}

func writeJSON(path string, value any) bool {
	encoded, err := json.Marshal(value)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return false
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return false
	}
	return true
}

func mergeTiming(target *ChildTiming, source ChildTiming) {
	target.DocumentOpenMs += source.DocumentOpenMs
	target.InventoryMs += source.InventoryMs
	target.PageLoadMs += source.PageLoadMs
	target.BitmapRenderMs += source.BitmapRenderMs
}

func writeTiming(prefix string, timing ChildTiming) {
	encoded, err := json.Marshal(timing)
	if err == nil {
		_ = os.WriteFile(prefix+".timing", encoded, 0o600)
	}
}
