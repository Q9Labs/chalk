package recordingdecode

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

const videoClockRate uint64 = 90_000

type videoSegment struct {
	path       string
	startTicks uint64
	width      uint16
	height     uint16
}

func toRTPPacket(packet recordingbundle.RTPPacket) rtp.Packet {
	return rtp.Packet{Header: rtp.Header{
		Version: 2, SequenceNumber: packet.SequenceNumber, Timestamp: packet.Timestamp,
		SSRC: packet.SSRC, PayloadType: packet.PayloadType, Marker: packet.Marker,
	}, Payload: packet.Payload}
}

func nominalFrameTicks(timestamps []uint64) uint64 {
	counts := make(map[uint64]int)
	var selected uint64 = 3_000
	selectedCount := 0
	for index := 1; index < len(timestamps); index++ {
		delta := timestamps[index] - timestamps[index-1]
		if delta == 0 || delta > videoClockRate {
			continue
		}
		counts[delta]++
		if counts[delta] > selectedCount || (counts[delta] == selectedCount && delta < selected) {
			selected, selectedCount = delta, counts[delta]
		}
	}
	return selected
}

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
		for {
			var frameHeader [12]byte
			_, err := io.ReadFull(input, frameHeader[:])
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return errors.Join(fmt.Errorf("%w: truncated IVF frame header", ErrDecode), closeFileWithContext(input, "close IVF segment"))
			}
			frameSize := binary.LittleEndian.Uint32(frameHeader[0:4])
			if frameSize == 0 || frameSize > recordingbundle.MaxPacketPayloadBytes*1_024 {
				return errors.Join(fmt.Errorf("%w: invalid IVF frame size", ErrDecode), closeFileWithContext(input, "close IVF segment"))
			}
			pts := binary.LittleEndian.Uint64(frameHeader[4:12]) + segment.startTicks - segments[0].startTicks
			binary.LittleEndian.PutUint64(frameHeader[4:12], pts)
			if _, err := output.Write(frameHeader[:]); err != nil {
				return errors.Join(fmt.Errorf("write IVF frame header: %w", err), closeFileWithContext(input, "close IVF segment"))
			}
			if _, err := io.CopyN(output, input, int64(frameSize)); err != nil {
				return errors.Join(fmt.Errorf("copy IVF frame: %w", err), closeFileWithContext(input, "close IVF segment"))
			}
			frameCount++
		}
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
