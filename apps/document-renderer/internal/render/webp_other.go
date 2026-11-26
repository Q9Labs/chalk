//go:build !linux

package render

import "fmt"

func EncodeWebP([]byte, int, int, float32) ([]byte, error) {
	return nil, fmt.Errorf("webp encoding is only supported on linux")
}

func EncodeWebPMethod(bgra []byte, width, height int, quality float32, method int) ([]byte, error) {
	return EncodeWebP(bgra, width, height, quality)
}
