package recordingdecode

import (
	"bufio"
	"bytes"
	"container/heap"
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

const spoolMergeFanIn = 32

type spoolRun struct {
	offset      int64
	length      int64
	packetCount uint64
}

type spoolRunGroup struct {
	generation uint64
	runs       []spoolRun
}

func appendFragmentRun(ctx context.Context, state *sourceState, fragment recordingbundle.RTPFragment, generation uint64) error {
	if len(fragment.Packets) == 0 {
		return nil
	}
	uniquePacketCount := 0
	for index, packet := range fragment.Packets {
		if err := ctx.Err(); err != nil {
			return err
		}
		if uint16(packet.ExtendedSequenceNumber) != packet.SequenceNumber {
			return fmt.Errorf("%w: extended RTP sequence does not match wire sequence", ErrInvalidBundle)
		}
		if len(packet.Payload) > recordingbundle.MaxPacketPayloadBytes {
			return fmt.Errorf("%w: source RTP payload exceeds bound", ErrInvalidBundle)
		}
		if index > 0 && packet.ExtendedSequenceNumber < fragment.Packets[index-1].ExtendedSequenceNumber {
			return fmt.Errorf("%w: source RTP run sequence regressed", ErrInvalidBundle)
		}
		if index > 0 && packet.ExtendedSequenceNumber == fragment.Packets[index-1].ExtendedSequenceNumber {
			if !sameStoredRTPPacket(packet, fragment.Packets[index-1]) {
				return fmt.Errorf("%w: conflicting source RTP packets share an extended sequence", ErrInvalidBundle)
			}
			continue
		}
		uniquePacketCount++
	}
	if len(state.spoolGroups) > 0 && generation < state.spoolGroups[len(state.spoolGroups)-1].generation {
		return fmt.Errorf("%w: source RTP recovery generation regressed", ErrInvalidBundle)
	}

	file, err := os.OpenFile(state.spoolPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open RTP spool run: %w", err)
	}
	offset, err := file.Seek(0, io.SeekEnd)
	if err != nil {
		return errors.Join(fmt.Errorf("locate RTP spool run: %w", err), closeFileWithContext(file, "close RTP spool run"))
	}
	buffer := bufio.NewWriterSize(file, 64<<10)
	var length int64
	for index, packet := range fragment.Packets {
		if err := ctx.Err(); err != nil {
			return errors.Join(err, abortSpoolRun(file, offset))
		}
		if index > 0 && packet.ExtendedSequenceNumber == fragment.Packets[index-1].ExtendedSequenceNumber {
			continue
		}
		if err := writeSpoolPacket(buffer, packet); err != nil {
			return errors.Join(fmt.Errorf("write RTP spool run: %w", err), abortSpoolRun(file, offset))
		}
		length += int64(spoolRecordHeaderBytes + len(packet.Payload))
	}
	if err := buffer.Flush(); err != nil {
		return errors.Join(fmt.Errorf("flush RTP spool run: %w", err), abortSpoolRun(file, offset))
	}
	if err := closeFileWithContext(file, "close RTP spool run"); err != nil {
		return err
	}

	run := spoolRun{offset: offset, length: length, packetCount: uint64(uniquePacketCount)}
	if len(state.spoolGroups) == 0 || state.spoolGroups[len(state.spoolGroups)-1].generation != generation {
		state.spoolGroups = append(state.spoolGroups, spoolRunGroup{generation: generation})
	}
	last := &state.spoolGroups[len(state.spoolGroups)-1]
	last.runs = append(last.runs, run)
	return nil
}

func abortSpoolRun(file *os.File, offset int64) error {
	truncateErr := file.Truncate(offset)
	if truncateErr != nil {
		truncateErr = fmt.Errorf("roll back incomplete RTP spool run: %w", truncateErr)
	}
	return errors.Join(truncateErr, closeFileWithContext(file, "close incomplete RTP spool run"))
}

func finalizeSourceSpool(ctx context.Context, state *sourceState) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(state.spoolGroups) == 0 {
		file, err := os.OpenFile(state.spoolPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return fmt.Errorf("create empty RTP spool: %w", err)
		}
		return closeFileWithContext(file, "close empty RTP spool")
	}

	groups := state.spoolGroups
	inputPath := state.spoolPath
	outputPath := state.spoolPath + ".merge"
	for spoolGroupsNeedMerge(groups) {
		if err := ctx.Err(); err != nil {
			if inputPath != state.spoolPath {
				err = errors.Join(err, removeFileWithContext(inputPath, "remove cancelled RTP spool merge input"))
			}
			return err
		}
		merged, err := mergeSpoolPass(ctx, inputPath, outputPath, groups)
		if err != nil {
			if inputPath != state.spoolPath {
				err = errors.Join(err, removeFileWithContext(inputPath, "remove failed RTP spool merge input"))
			}
			return err
		}
		groups = merged
		inputPath, outputPath = outputPath, inputPath
	}
	if inputPath != state.spoolPath {
		if err := ctx.Err(); err != nil {
			return errors.Join(err, removeFileWithContext(inputPath, "remove cancelled RTP spool merge output"))
		}
		if err := os.Rename(inputPath, state.spoolPath); err != nil {
			return errors.Join(
				fmt.Errorf("publish merged RTP spool: %w", err),
				removeFileWithContext(inputPath, "remove unpublished RTP spool merge output"),
			)
		}
	}
	state.spoolGroups = groups
	return nil
}

func spoolGroupsNeedMerge(groups []spoolRunGroup) bool {
	for _, group := range groups {
		if len(group.runs) > 1 {
			return true
		}
	}
	return false
}

func mergeSpoolPass(ctx context.Context, inputPath, outputPath string, groups []spoolRunGroup) (result []spoolRunGroup, resultErr error) {
	input, err := os.Open(inputPath)
	if err != nil {
		return nil, fmt.Errorf("open RTP spool merge input: %w", err)
	}
	output, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("create RTP spool merge output: %w", err), closeFileWithContext(input, "close RTP spool merge input"))
	}
	defer func() {
		if resultErr != nil {
			resultErr = errors.Join(resultErr, removeFileWithContext(outputPath, "remove incomplete RTP spool merge output"))
		}
	}()

	inputInfo, statErr := input.Stat()
	buffer := bufio.NewWriterSize(output, 64<<10)
	counting := &countingWriter{writer: buffer}
	if statErr == nil {
		result = make([]spoolRunGroup, 0, len(groups))
		for _, group := range groups {
			if err := ctx.Err(); err != nil {
				resultErr = err
				break
			}
			next := spoolRunGroup{generation: group.generation, runs: make([]spoolRun, 0, (len(group.runs)+spoolMergeFanIn-1)/spoolMergeFanIn)}
			for start := 0; start < len(group.runs); start += spoolMergeFanIn {
				end := min(start+spoolMergeFanIn, len(group.runs))
				offset := counting.written
				packetCount, mergeErr := mergeRunChunk(ctx, input, inputInfo.Size(), counting, group.runs[start:end])
				if mergeErr != nil {
					resultErr = mergeErr
					break
				}
				next.runs = append(next.runs, spoolRun{offset: offset, length: counting.written - offset, packetCount: packetCount})
			}
			if resultErr != nil {
				break
			}
			result = append(result, next)
		}
	} else {
		resultErr = fmt.Errorf("inspect RTP spool merge input: %w", statErr)
	}
	if err := buffer.Flush(); err != nil {
		resultErr = errors.Join(resultErr, fmt.Errorf("flush RTP spool merge output: %w", err))
	}
	resultErr = errors.Join(resultErr,
		closeFileWithContext(input, "close RTP spool merge input"),
		closeFileWithContext(output, "close RTP spool merge output"),
	)
	if resultErr != nil {
		return nil, resultErr
	}
	if err := removeFileWithContext(inputPath, "remove consumed RTP spool merge input"); err != nil {
		resultErr = err
		return nil, resultErr
	}
	return result, nil
}

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

func mergeRunChunk(ctx context.Context, input io.ReaderAt, inputSize int64, output io.Writer, runs []spoolRun) (packetCount uint64, resultErr error) {
	readers := make([]*spoolRunReader, len(runs))
	packets := make(spoolPacketHeap, 0, len(runs))
	defer func() {
		for index := range packets {
			clear(packets[index].packet.Payload)
		}
	}()
	for index, run := range runs {
		reader, err := newSpoolRunReader(input, inputSize, run)
		if err != nil {
			return 0, err
		}
		readers[index] = reader
		packet, ok, err := reader.next()
		if err != nil {
			return 0, err
		}
		if !ok {
			return 0, fmt.Errorf("%w: empty RTP spool run", ErrDecode)
		}
		packets = append(packets, spoolHeapItem{readerIndex: index, packet: packet})
	}
	heap.Init(&packets)

	var previous recordingbundle.RTPPacket
	defer func() { clear(previous.Payload) }()
	var hasPacket bool
	for packets.Len() > 0 {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		item := heap.Pop(&packets).(spoolHeapItem)
		if hasPacket && item.packet.ExtendedSequenceNumber < previous.ExtendedSequenceNumber {
			clear(item.packet.Payload)
			return 0, fmt.Errorf("%w: source RTP sequence regressed during merge", ErrInvalidBundle)
		}
		if hasPacket && item.packet.ExtendedSequenceNumber == previous.ExtendedSequenceNumber {
			if !sameStoredRTPPacket(item.packet, previous) {
				clear(item.packet.Payload)
				return 0, fmt.Errorf("%w: conflicting source RTP packets share an extended sequence", ErrInvalidBundle)
			}
			clear(item.packet.Payload)
		} else {
			if err := writeSpoolPacket(output, item.packet); err != nil {
				clear(item.packet.Payload)
				return 0, fmt.Errorf("write merged RTP spool: %w", err)
			}
			clear(previous.Payload)
			previous = item.packet
			hasPacket = true
			packetCount++
		}

		next, ok, err := readers[item.readerIndex].next()
		if err != nil {
			return 0, err
		}
		if ok {
			heap.Push(&packets, spoolHeapItem{readerIndex: item.readerIndex, packet: next})
		}
	}
	return packetCount, nil
}

func sameStoredRTPPacket(left, right recordingbundle.RTPPacket) bool {
	return left.SequenceNumber == right.SequenceNumber &&
		left.ExtendedSequenceNumber == right.ExtendedSequenceNumber &&
		left.Timestamp == right.Timestamp &&
		left.SSRC == right.SSRC &&
		left.PayloadType == right.PayloadType &&
		left.Marker == right.Marker &&
		bytes.Equal(left.Payload, right.Payload)
}
