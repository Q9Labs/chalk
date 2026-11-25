//go:build linux

package render

/*
#cgo CFLAGS: -I${SRCDIR}/../../native/pdfium/include
#cgo LDFLAGS: -L${SRCDIR}/../../native/pdfium/lib -lpdfium
#include <stdlib.h>
#include <string.h>
#include <fpdfview.h>
#include <fpdf_edit.h>

static FPDF_DOCUMENT load_mem(void *data, int length) {
	return FPDF_LoadMemDocument(data, length, "");
}
*/
import "C"
import (
	"fmt"
	"sync"
	"unsafe"
)

var initPDFium sync.Once

type PDFPage struct {
	Width    int
	Height   int
	Rotation int
}

type PDFInventory struct {
	PageCount int
	Pages     []PDFPage
}

func PDFInventoryFromBytes(data []byte) (PDFInventory, string, error) {
	initPDFium.Do(func() { C.FPDF_InitLibrary() })
	if len(data) == 0 {
		return PDFInventory{}, "corrupt", fmt.Errorf("empty pdf")
	}
	document := C.load_mem(unsafe.Pointer(&data[0]), C.int(len(data)))
	if document == nil {
		code := int(C.FPDF_GetLastError())
		failure := "corrupt"
		if code == C.FPDF_ERR_PASSWORD || code == C.FPDF_ERR_SECURITY {
			failure = "password_protected"
		}
		return PDFInventory{}, failure, fmt.Errorf("pdf open failed with pdfium error %d", code)
	}
	defer C.FPDF_CloseDocument(document)
	count := int(C.FPDF_GetPageCount(document))
	if count < 1 || count > 300 {
		return PDFInventory{}, "too_many_pages", fmt.Errorf("pdf has %d pages", count)
	}
	inventory := PDFInventory{PageCount: count, Pages: make([]PDFPage, 0, count)}
	for index := 0; index < count; index++ {
		widthPoints := float64(C.FPDF_GetPageWidth(document, C.int(index)))
		heightPoints := float64(C.FPDF_GetPageHeight(document, C.int(index)))
		if widthPoints <= 0 || heightPoints <= 0 {
			C.FPDF_CloseDocument(document)
			return PDFInventory{}, "corrupt", fmt.Errorf("pdf page %d has invalid dimensions", index+1)
		}
		rotation := 0
		if page := C.FPDF_LoadPage(document, C.int(index)); page != nil {
			rotation = int(C.FPDFPage_GetRotation(page))
			C.FPDF_ClosePage(page)
		}
		displayWidth, displayHeight := widthPoints, heightPoints
		if rotation == 1 || rotation == 3 {
			displayWidth, displayHeight = displayHeight, displayWidth
		}
		width, height := scaledDimensions(displayWidth, displayHeight, 1600)
		inventory.Pages = append(inventory.Pages, PDFPage{Width: width, Height: height, Rotation: rotation})
	}
	return inventory, "", nil
}

func RenderPDFPage(data []byte, pageNumber int, targetEdge int) ([]byte, int, int, string, error) {
	initPDFium.Do(func() { C.FPDF_InitLibrary() })
	if len(data) == 0 || pageNumber < 1 || targetEdge < 1 {
		return nil, 0, 0, "corrupt", fmt.Errorf("invalid pdf render input")
	}
	document := C.load_mem(unsafe.Pointer(&data[0]), C.int(len(data)))
	if document == nil {
		code := int(C.FPDF_GetLastError())
		failure := "corrupt"
		if code == C.FPDF_ERR_PASSWORD || code == C.FPDF_ERR_SECURITY {
			failure = "password_protected"
		}
		return nil, 0, 0, failure, fmt.Errorf("pdf open failed with pdfium error %d", code)
	}
	defer C.FPDF_CloseDocument(document)
	page := C.FPDF_LoadPage(document, C.int(pageNumber-1))
	if page == nil {
		return nil, 0, 0, "corrupt", fmt.Errorf("pdf page %d unavailable", pageNumber)
	}
	defer C.FPDF_ClosePage(page)
	widthPoints := float64(C.FPDF_GetPageWidth(page))
	heightPoints := float64(C.FPDF_GetPageHeight(page))
	rotation := int(C.FPDFPage_GetRotation(page))
	displayWidth, displayHeight := widthPoints, heightPoints
	if rotation == 1 || rotation == 3 {
		displayWidth, displayHeight = displayHeight, displayWidth
	}
	width, height := scaledDimensions(displayWidth, displayHeight, targetEdge)
	stride := width * 4
	bitmap := C.FPDFBitmap_CreateEx(C.int(width), C.int(height), C.FPDFBitmap_BGRA, nil, C.int(stride))
	if bitmap == nil {
		return nil, 0, 0, "render_failed", fmt.Errorf("allocate pdf bitmap")
	}
	defer C.FPDFBitmap_Destroy(bitmap)
	C.FPDFBitmap_FillRect(bitmap, 0, 0, C.int(width), C.int(height), C.ulong(0xffffffff))
	C.FPDF_RenderPageBitmap(bitmap, page, 0, 0, C.int(width), C.int(height), 0, C.int(C.FPDF_LCD_TEXT))
	buffer := C.FPDFBitmap_GetBuffer(bitmap)
	if buffer == nil {
		return nil, 0, 0, "render_failed", fmt.Errorf("pdf bitmap buffer unavailable")
	}
	return C.GoBytes(buffer, C.int(stride*height)), width, height, "", nil
}

func scaledDimensions(widthPoints, heightPoints float64, targetEdge int) (int, int) {
	longest := widthPoints
	if heightPoints > longest {
		longest = heightPoints
	}
	scale := float64(targetEdge) / longest
	width := int(widthPoints*scale + 0.5)
	height := int(heightPoints*scale + 0.5)
	if width < 1 {
		width = 1
	}
	if height < 1 {
		height = 1
	}
	return width, height
}
