//go:build linux

package render

/*
#cgo LDFLAGS: -lwebp
#include <stdlib.h>
#include <webp/encode.h>
*/
import "C"
import (
	"fmt"
	"unsafe"
)

func EncodeWebP(bgra []byte, width, height int, quality float32) ([]byte, error) {
	if width <= 0 || height <= 0 || len(bgra) < width*height*4 {
		return nil, fmt.Errorf("invalid image buffer")
	}
	var output *C.uint8_t
	size := C.WebPEncodeBGRA((*C.uint8_t)(unsafe.Pointer(&bgra[0])), C.int(width), C.int(height), C.int(width*4), C.float(quality), &output)
	if size == 0 || output == nil {
		return nil, fmt.Errorf("webp encode failed")
	}
	defer C.WebPFree(unsafe.Pointer(output))
	return C.GoBytes(unsafe.Pointer(output), C.int(size)), nil
}
