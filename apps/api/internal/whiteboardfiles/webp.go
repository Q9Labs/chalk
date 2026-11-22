package whiteboardfiles

import (
	"bytes"
	"encoding/binary"
	"image"
	"io"

	"golang.org/x/image/riff"
)

func firstWebPFrame(body []byte, canvas image.Config) ([]byte, error) {
	// Animated WebP always starts with the extended header and animation bit.
	if len(body) < 30 || string(body[12:16]) != "VP8X" || body[20]&0x02 == 0 {
		return body, nil
	}
	_, chunks, err := riff.NewReader(bytes.NewReader(body))
	if err != nil {
		return nil, ErrFileTransferFailed
	}
	sawAnimation := false
	for {
		id, size, chunk, err := chunks.Next()
		if err != nil {
			return nil, ErrFileTransferFailed
		}
		switch string(id[:]) {
		case "ANIM":
			sawAnimation = size == 6
		case "ANMF":
			if !sawAnimation {
				return nil, ErrFileTransferFailed
			}
			return decodeWebPFrame(chunk, size, body[:30], canvas)
		}
	}
}

func decodeWebPFrame(chunk io.Reader, size uint32, header []byte, canvas image.Config) ([]byte, error) {
	var frame [16]byte
	if size < uint32(len(frame))+8 {
		return nil, ErrFileTransferFailed
	}
	if _, err := io.ReadFull(chunk, frame[:]); err != nil {
		return nil, ErrFileTransferFailed
	}
	uint24 := func(b []byte) int { return int(b[0]) | int(b[1])<<8 | int(b[2])<<16 }
	x, y := 2*uint24(frame[0:3]), 2*uint24(frame[3:6])
	width, height := 1+uint24(frame[6:9]), 1+uint24(frame[9:12])
	if x+width > canvas.Width || y+height > canvas.Height || frame[15]&0xfc != 0 {
		return nil, ErrFileTransferFailed
	}

	subchunks, err := io.ReadAll(chunk)
	if err != nil || len(subchunks) != int(size)-len(frame) {
		return nil, ErrFileTransferFailed
	}
	picture := bytes.Clone(header)
	binary.LittleEndian.PutUint32(picture[4:8], uint32(len(picture)+len(subchunks)-8))
	picture[20] = 0
	if string(subchunks[:4]) == "ALPH" {
		picture[20] = 0x10
	}
	copy(picture[24:30], frame[6:12])
	return append(picture, subchunks...), nil
}
