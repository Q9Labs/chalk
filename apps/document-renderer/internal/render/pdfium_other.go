//go:build !linux

package render

import "fmt"

type PDFPage struct {
	Width    int
	Height   int
	Rotation int
}
type PDFInventory struct {
	PageCount int
	Pages     []PDFPage
}

func PDFInventoryFromBytes([]byte) (PDFInventory, string, error) {
	return PDFInventory{}, "unsupported", fmt.Errorf("pdf rendering is only supported on linux")
}
func RenderPDFPage([]byte, int, int) ([]byte, int, int, string, error) {
	return nil, 0, 0, "unsupported", fmt.Errorf("pdf rendering is only supported on linux")
}

func PDFInventoryFromBytesTimed(data []byte) (PDFInventory, ChildTiming, string, error) {
	inventory, failure, err := PDFInventoryFromBytes(data)
	return inventory, ChildTiming{}, failure, err
}
func RenderPDFPageTimed(data []byte, page, target int) ([]byte, int, int, ChildTiming, string, error) {
	bitmap, width, height, failure, err := RenderPDFPage(data, page, target)
	return bitmap, width, height, ChildTiming{}, failure, err
}
