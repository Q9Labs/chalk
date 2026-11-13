package recordingdecode

import (
	"bufio"
	"errors"
	"fmt"
	"io"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

type countingWriter struct {
	writer  io.Writer
	written int64
}

func (writer *countingWriter) Write(value []byte) (int, error) {
	written, err := writer.writer.Write(value)
	writer.written += int64(written)
	return written, err
}

type spoolRunReader struct {
	reader    *bufio.Reader
	limited   *io.LimitedReader
	remaining uint64
	finished  bool
}

func newSpoolRunReader(input io.ReaderAt, inputSize int64, run spoolRun) (*spoolRunReader, error) {
	if run.offset < 0 || run.length <= 0 || run.packetCount == 0 || run.offset > inputSize-run.length {
		return nil, fmt.Errorf("%w: invalid RTP spool run descriptor", ErrDecode)
	}
	limited := &io.LimitedReader{R: io.NewSectionReader(input, run.offset, run.length), N: run.length}
	return &spoolRunReader{reader: bufio.NewReaderSize(limited, spoolRecordHeaderBytes), limited: limited, remaining: run.packetCount}, nil
}

func (reader *spoolRunReader) next() (recordingbundle.RTPPacket, bool, error) {
	if reader.finished {
		return recordingbundle.RTPPacket{}, false, nil
	}
	if reader.remaining == 0 {
		reader.finished = true
		if _, err := reader.reader.ReadByte(); !errors.Is(err, io.EOF) {
			if err == nil {
				return recordingbundle.RTPPacket{}, false, fmt.Errorf("%w: RTP spool run contains trailing bytes", ErrDecode)
			}
			return recordingbundle.RTPPacket{}, false, fmt.Errorf("%w: inspect RTP spool run boundary: %v", ErrDecode, err)
		}
		if reader.limited.N != 0 {
			return recordingbundle.RTPPacket{}, false, fmt.Errorf("%w: truncated RTP spool run", ErrDecode)
		}
		return recordingbundle.RTPPacket{}, false, nil
	}
	packet, err := readSpoolPacket(reader.reader)
	if err != nil {
		return recordingbundle.RTPPacket{}, false, fmt.Errorf("%w: truncated or malformed RTP spool run: %v", ErrDecode, err)
	}
	reader.remaining--
	return packet, true, nil
}

type spoolHeapItem struct {
	readerIndex int
	packet      recordingbundle.RTPPacket
}

type spoolPacketHeap []spoolHeapItem

func (values spoolPacketHeap) Len() int { return len(values) }

func (values spoolPacketHeap) Less(left, right int) bool {
	if values[left].packet.ExtendedSequenceNumber != values[right].packet.ExtendedSequenceNumber {
		return values[left].packet.ExtendedSequenceNumber < values[right].packet.ExtendedSequenceNumber
	}
	return values[left].readerIndex < values[right].readerIndex
}

func (values spoolPacketHeap) Swap(left, right int) {
	values[left], values[right] = values[right], values[left]
}

func (values *spoolPacketHeap) Push(value any) { *values = append(*values, value.(spoolHeapItem)) }

func (values *spoolPacketHeap) Pop() any {
	old := *values
	last := len(old) - 1
	value := old[last]
	old[last] = spoolHeapItem{}
	*values = old[:last]
	return value
}
