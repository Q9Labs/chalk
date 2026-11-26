//go:build linux

package render

/*
#cgo LDFLAGS: -lwebp
#include <stdlib.h>
#include <webp/encode.h>

static size_t chalk_encode_webp_bgra(const uint8_t* bgra, int width, int height, int stride, float quality, int method, uint8_t** output) {
  WebPConfig config;
  WebPPicture picture;
  WebPMemoryWriter writer;
  if (!WebPConfigInit(&config) || !WebPPictureInit(&picture)) return 0;
  config.quality = quality;
  config.method = method;
  config.thread_level = 1;
  if (!WebPValidateConfig(&config)) return 0;
  picture.width = width;
  picture.height = height;
  picture.use_argb = 0;
  WebPMemoryWriterInit(&writer);
  picture.writer = WebPMemoryWrite;
  picture.custom_ptr = &writer;
  if (!WebPPictureImportBGRA(&picture, bgra, stride)) {
    WebPPictureFree(&picture);
    WebPMemoryWriterClear(&writer);
    return 0;
  }
  if (!WebPEncode(&config, &picture)) {
    WebPPictureFree(&picture);
    WebPMemoryWriterClear(&writer);
    return 0;
  }
  WebPPictureFree(&picture);
  *output = writer.mem;
  return writer.size;
}
*/
import "C"
import (
	"fmt"
	"unsafe"
)

// EncodeWebP uses low-effort lossy compression. The renderer already pays for
// a high-resolution bitmap once; spending several seconds per page on maximum
// compression is the wrong tradeoff for interactive documents.
func EncodeWebP(bgra []byte, width, height int, quality float32) ([]byte, error) {
	return EncodeWebPMethod(bgra, width, height, quality, 1)
}

func EncodeWebPMethod(bgra []byte, width, height int, quality float32, method int) ([]byte, error) {
	if width <= 0 || height <= 0 || len(bgra) < width*height*4 || method < 0 || method > 6 {
		return nil, fmt.Errorf("invalid image buffer")
	}
	var output *C.uint8_t
	size := C.chalk_encode_webp_bgra((*C.uint8_t)(unsafe.Pointer(&bgra[0])), C.int(width), C.int(height), C.int(width*4), C.float(quality), C.int(method), &output)
	if size == 0 || output == nil {
		return nil, fmt.Errorf("webp encode failed")
	}
	defer C.WebPFree(unsafe.Pointer(output))
	return C.GoBytes(unsafe.Pointer(output), C.int(size)), nil
}
