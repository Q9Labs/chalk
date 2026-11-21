package recordingdecode

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func mergeIVF(outputPath string, segments []videoSegment) (resultErr error) {
	if len(segments) == 0 {
		return fmt.Errorf("%w: no IVF segments", ErrDecode)
	}
	output, err := os.OpenFile(outputPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("create merged IVF: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(output, "close merged IVF"))
	}()
	var outputHeader [32]byte
	var frameCount uint64
	for index, segment := range segments {
		input, err := os.Open(segment.path)
		if err != nil {
			return fmt.Errorf("open IVF segment: %w", err)
		}
		var header [32]byte
		if _, err := io.ReadFull(input, header[:]); err != nil || string(header[0:4]) != "DKIF" || string(header[8:12]) != "VP80" {
			return errors.Join(fmt.Errorf("%w: invalid IVF segment", ErrDecode), closeFileWithContext(input, "close IVF segment"))
		}
		if index == 0 {
			outputHeader = header
			if _, err := output.Write(outputHeader[:]); err != nil {
				return errors.Join(fmt.Errorf("write IVF header: %w", err), closeFileWithContext(input, "close IVF segment"))
			}
		}
		count, err := appendIVFFrames(output, input, segment.startTicks-segments[0].startTicks)
		if err != nil {
			return errors.Join(err, closeFileWithContext(input, "close IVF segment"))
		}
		frameCount += count
		if err := closeFileWithContext(input, "close IVF segment"); err != nil {
			return err
		}
	}
	if frameCount == 0 || frameCount > uint64(^uint32(0)) {
		return fmt.Errorf("%w: invalid IVF frame count", ErrDecode)
	}
	binary.LittleEndian.PutUint32(outputHeader[24:28], uint32(frameCount))
	if _, err := output.WriteAt(outputHeader[:], 0); err != nil {
		return fmt.Errorf("finalize IVF header: %w", err)
	}
	return nil
}

func appendIVFFrames(output, input *os.File, tickOffset uint64) (uint64, error) {
	var frameCount uint64
	for {
		var frameHeader [12]byte
		_, err := io.ReadFull(input, frameHeader[:])
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return 0, fmt.Errorf("%w: truncated IVF frame header", ErrDecode)
		}
		frameSize := binary.LittleEndian.Uint32(frameHeader[0:4])
		if frameSize == 0 || frameSize > recordingbundle.MaxPacketPayloadBytes*1_024 {
			return 0, fmt.Errorf("%w: invalid IVF frame size", ErrDecode)
		}
		pts := binary.LittleEndian.Uint64(frameHeader[4:12]) + tickOffset
		binary.LittleEndian.PutUint64(frameHeader[4:12], pts)
		if _, err := output.Write(frameHeader[:]); err != nil {
			return 0, fmt.Errorf("write IVF frame header: %w", err)
		}
		if _, err := io.CopyN(output, input, int64(frameSize)); err != nil {
			return 0, fmt.Errorf("copy IVF frame: %w", err)
		}
		frameCount++
	}
	return frameCount, nil
}
