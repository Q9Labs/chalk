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
	"runtime"
	"sync"
	"time"
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

func loadPDFDocument(data []byte) (C.FPDF_DOCUMENT, func()) {
	var pinner runtime.Pinner
	pinner.Pin(&data[0])
	document := C.load_mem(unsafe.Pointer(&data[0]), C.int(len(data)))
	if document == nil {
		pinner.Unpin()
		return nil, nil
	}
	return document, func() {
		C.FPDF_CloseDocument(document)
		pinner.Unpin()
	}
}

func PDFInventoryFromBytes(data []byte) (PDFInventory, string, error) {
	inventory, _, failure, err := PDFInventoryFromBytesTimed(data)
	return inventory, failure, err
}

func PDFInventoryFromBytesTimed(data []byte) (PDFInventory, ChildTiming, string, error) {
	var timing ChildTiming
	initPDFium.Do(func() { C.FPDF_InitLibrary() })
	if len(data) == 0 {
		return PDFInventory{}, timing, "corrupt", fmt.Errorf("empty pdf")
	}
	openStarted := time.Now()
	document, closeDocument := loadPDFDocument(data)
	timing.DocumentOpenMs = time.Since(openStarted).Milliseconds()
	if document == nil {
		code := int(C.FPDF_GetLastError())
		failure := "corrupt"
		if code == C.FPDF_ERR_PASSWORD || code == C.FPDF_ERR_SECURITY {
			failure = "password_protected"
		}
		return PDFInventory{}, timing, failure, fmt.Errorf("pdf open failed with pdfium error %d", code)
	}
	defer closeDocument()
	inventoryStarted := time.Now()
	count := int(C.FPDF_GetPageCount(document))
	if count < 1 || count > 300 {
		return PDFInventory{}, timing, "too_many_pages", fmt.Errorf("pdf has %d pages", count)
	}
	inventory := PDFInventory{PageCount: count, Pages: make([]PDFPage, 0, count)}
	for index := 0; index < count; index++ {
		page := C.FPDF_LoadPage(document, C.int(index))
		if page == nil {
			return PDFInventory{}, timing, "corrupt", fmt.Errorf("pdf page %d unavailable", index+1)
		}
		widthPoints := float64(C.FPDF_GetPageWidth(page))
		heightPoints := float64(C.FPDF_GetPageHeight(page))
		rotation := int(C.FPDFPage_GetRotation(page))
		C.FPDF_ClosePage(page)
		if widthPoints <= 0 || heightPoints <= 0 {
			return PDFInventory{}, timing, "corrupt", fmt.Errorf("pdf page %d has invalid dimensions", index+1)
		}
		displayWidth, displayHeight := widthPoints, heightPoints
		if rotation == 1 || rotation == 3 {
			displayWidth, displayHeight = displayHeight, displayWidth
		}
		width, height := scaledDimensions(displayWidth, displayHeight, 1600)
		inventory.Pages = append(inventory.Pages, PDFPage{Width: width, Height: height, Rotation: rotation})
	}
	timing.InventoryMs = time.Since(inventoryStarted).Milliseconds()
	return inventory, timing, "", nil
}

func RenderPDFPage(data []byte, pageNumber int, targetEdge int) ([]byte, int, int, string, error) {
	bitmap, width, height, _, failure, err := RenderPDFPageTimed(data, pageNumber, targetEdge)
	return bitmap, width, height, failure, err
}

func RenderPDFPageTimed(data []byte, pageNumber int, targetEdge int) ([]byte, int, int, ChildTiming, string, error) {
	var timing ChildTiming
	initPDFium.Do(func() { C.FPDF_InitLibrary() })
	if len(data) == 0 || pageNumber < 1 || targetEdge < 1 {
		return nil, 0, 0, timing, "corrupt", fmt.Errorf("invalid pdf render input")
	}
	openStarted := time.Now()
	document, closeDocument := loadPDFDocument(data)
	timing.DocumentOpenMs = time.Since(openStarted).Milliseconds()
	if document == nil {
		code := int(C.FPDF_GetLastError())
		failure := "corrupt"
		if code == C.FPDF_ERR_PASSWORD || code == C.FPDF_ERR_SECURITY {
			failure = "password_protected"
		}
		return nil, 0, 0, timing, failure, fmt.Errorf("pdf open failed with pdfium error %d", code)
	}
	defer closeDocument()
	loadStarted := time.Now()
	page := C.FPDF_LoadPage(document, C.int(pageNumber-1))
	timing.PageLoadMs = time.Since(loadStarted).Milliseconds()
	if page == nil {
		return nil, 0, 0, timing, "corrupt", fmt.Errorf("pdf page %d unavailable", pageNumber)
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
	renderStarted := time.Now()
	bitmap := C.FPDFBitmap_CreateEx(C.int(width), C.int(height), C.FPDFBitmap_BGRA, nil, C.int(stride))
	if bitmap == nil {
		return nil, 0, 0, timing, "render_failed", fmt.Errorf("allocate pdf bitmap")
	}
	defer C.FPDFBitmap_Destroy(bitmap)
	C.FPDFBitmap_FillRect(bitmap, 0, 0, C.int(width), C.int(height), C.ulong(0xffffffff))
	C.FPDF_RenderPageBitmap(bitmap, page, 0, 0, C.int(width), C.int(height), 0, C.int(C.FPDF_LCD_TEXT))
	buffer := C.FPDFBitmap_GetBuffer(bitmap)
	if buffer == nil {
		return nil, 0, 0, timing, "render_failed", fmt.Errorf("pdf bitmap buffer unavailable")
	}
	result := C.GoBytes(buffer, C.int(stride*height))
	timing.BitmapRenderMs = time.Since(renderStarted).Milliseconds()
	return result, width, height, timing, "", nil
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
