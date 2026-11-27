package office

import (
	"bytes"
	"encoding/binary"
	"errors"
	"unicode/utf16"
)

var cfbMagic = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}

var errBadCFB = errors.New("malformed compound file")

const (
	cfbMaxRegularSector = 0xFFFFFFFA
	cfbMaxEntries       = 1 << 14
	cfbDirectoryEntry   = 128
	cfbMiniSector       = 64
)

type cfbEntry struct {
	name  string
	kind  byte
	start uint32
	size  uint64
}

type cfbFile struct {
	data       []byte
	sectorSize int
	fat        []uint32
	miniFAT    []uint32
	miniStream []byte
	miniCutoff uint32
	entries    []cfbEntry
}

func isCFB(data []byte) bool { return bytes.HasPrefix(data, cfbMagic) }

func openCFB(data []byte) (*cfbFile, error) {
	if len(data) < 512 || !isCFB(data) {
		return nil, errBadCFB
	}
	shift := binary.LittleEndian.Uint16(data[0x1E:])
	if shift != 9 && shift != 12 {
		return nil, errBadCFB
	}
	file := &cfbFile{data: data, sectorSize: 1 << shift, miniCutoff: binary.LittleEndian.Uint32(data[0x38:])}
	word := func(offset int) uint32 { return binary.LittleEndian.Uint32(data[offset:]) }
	var fatSectors []uint32
	for index := range 109 {
		if sector := word(0x4C + 4*index); sector <= cfbMaxRegularSector {
			fatSectors = append(fatSectors, sector)
		}
	}
	next := word(0x44)
	for range word(0x48) {
		if next > cfbMaxRegularSector {
			break
		}
		sector, err := file.sector(next)
		if err != nil {
			return nil, err
		}
		perSector := file.sectorSize/4 - 1
		for index := range perSector {
			if entry := binary.LittleEndian.Uint32(sector[4*index:]); entry <= cfbMaxRegularSector {
				fatSectors = append(fatSectors, entry)
			}
		}
		next = binary.LittleEndian.Uint32(sector[4*perSector:])
	}
	for _, number := range fatSectors {
		sector, err := file.sector(number)
		if err != nil {
			return nil, err
		}
		for index := 0; index+4 <= len(sector); index += 4 {
			file.fat = append(file.fat, binary.LittleEndian.Uint32(sector[index:]))
		}
	}
	directory, err := file.readChain(word(0x30), cfbMaxEntries*cfbDirectoryEntry)
	if err != nil {
		return nil, err
	}
	for offset := 0; offset+cfbDirectoryEntry <= len(directory); offset += cfbDirectoryEntry {
		raw := directory[offset : offset+cfbDirectoryEntry]
		nameBytes := min(int(binary.LittleEndian.Uint16(raw[0x40:])), 64)
		units := make([]uint16, 0, 32)
		for index := 0; index+1 < nameBytes-1; index += 2 {
			units = append(units, binary.LittleEndian.Uint16(raw[index:]))
		}
		file.entries = append(file.entries, cfbEntry{
			name:  string(utf16.Decode(units)),
			kind:  raw[0x42],
			start: binary.LittleEndian.Uint32(raw[0x74:]),
			size:  binary.LittleEndian.Uint64(raw[0x78:]),
		})
	}
	if len(file.entries) == 0 {
		return nil, errBadCFB
	}
	if file.sectorSize == 512 {
		for index := range file.entries {
			file.entries[index].size &= 0xFFFFFFFF
		}
	}
	return file, nil
}

func (f *cfbFile) sector(number uint32) ([]byte, error) {
	offset := (int64(number) + 1) * int64(f.sectorSize)
	if offset+int64(f.sectorSize) > int64(len(f.data)) {
		return nil, errBadCFB
	}
	return f.data[offset : offset+int64(f.sectorSize)], nil
}

func (f *cfbFile) readChain(start uint32, limit int) ([]byte, error) {
	var out []byte
	sector := start
	for steps := 0; sector <= cfbMaxRegularSector && len(out) < limit; steps++ {
		if steps > len(f.fat) || int(sector) >= len(f.fat) {
			return nil, errBadCFB
		}
		data, err := f.sector(sector)
		if err != nil {
			return nil, err
		}
		out = append(out, data...)
		sector = f.fat[sector]
	}
	return out[:min(len(out), limit)], nil
}

func (f *cfbFile) has(name string) bool {
	for _, entry := range f.entries {
		if entry.name == name && entry.kind != 0 {
			return true
		}
	}
	return false
}

func (f *cfbFile) stream(name string, limit int) ([]byte, bool, error) {
	for _, entry := range f.entries {
		if entry.name != name || entry.kind != 2 {
			continue
		}
		size := int(min(entry.size, uint64(limit)))
		if entry.size >= uint64(f.miniCutoff) {
			data, err := f.readChain(entry.start, size)
			return data, true, err
		}
		if f.miniStream == nil {
			if err := f.loadMini(); err != nil {
				return nil, true, err
			}
		}
		var out []byte
		sector := entry.start
		for steps := 0; sector <= cfbMaxRegularSector && len(out) < size; steps++ {
			offset := int(sector) * cfbMiniSector
			if steps > len(f.miniFAT) || int(sector) >= len(f.miniFAT) || offset+cfbMiniSector > len(f.miniStream) {
				return nil, true, errBadCFB
			}
			out = append(out, f.miniStream[offset:offset+cfbMiniSector]...)
			sector = f.miniFAT[sector]
		}
		return out[:min(len(out), size)], true, nil
	}
	return nil, false, nil
}

func (f *cfbFile) loadMini() error {
	root := f.entries[0]
	stream, err := f.readChain(root.start, int(min(root.size, uint64(len(f.data)))))
	if err != nil {
		return err
	}
	f.miniStream = append([]byte{}, stream...)
	table, err := f.readChain(binary.LittleEndian.Uint32(f.data[0x3C:]), len(f.data))
	if err != nil {
		return err
	}
	for index := 0; index+4 <= len(table); index += 4 {
		f.miniFAT = append(f.miniFAT, binary.LittleEndian.Uint32(table[index:]))
	}
	return nil
}
