package office

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"sort"
	"testing"
	"unicode/utf16"
)

func zipOf(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(entries[name])); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

type cfbStream struct {
	name string
	data []byte
}

func buildCFB(t *testing.T, streams ...cfbStream) []byte {
	t.Helper()
	const sector = 512
	var mini []byte
	var miniFAT []uint32
	type placed struct {
		cfbStream
		mini  bool
		start uint32
	}
	items := make([]placed, len(streams))
	var big [][]byte
	for index, stream := range streams {
		items[index] = placed{cfbStream: stream, mini: len(stream.data) < 4096}
		if !items[index].mini {
			continue
		}
		items[index].start = uint32(len(mini) / 64)
		padded := append(append([]byte{}, stream.data...), make([]byte, (64-len(stream.data)%64)%64)...)
		count := len(padded) / 64
		for part := range count {
			if part == count-1 {
				miniFAT = append(miniFAT, 0xFFFFFFFE)
				continue
			}
			miniFAT = append(miniFAT, uint32(len(mini)/64+part+1))
		}
		mini = append(mini, padded...)
	}
	ceil := func(size int) int { return (size + sector - 1) / sector }
	directorySectors := ceil((len(streams) + 1) * 128)
	miniFATSectors := ceil(len(miniFAT) * 4)
	miniSectors := ceil(len(mini))
	next := 1 + directorySectors + miniFATSectors + miniSectors
	fat := make([]uint32, sector/4)
	for index := range fat {
		fat[index] = 0xFFFFFFFF
	}
	fat[0] = 0xFFFFFFFD
	chain := func(first, count int) {
		for index := range count {
			if index == count-1 {
				fat[first+index] = 0xFFFFFFFE
				continue
			}
			fat[first+index] = uint32(first + index + 1)
		}
	}
	chain(1, directorySectors)
	miniFATStart, miniStart := 1+directorySectors, 1+directorySectors+miniFATSectors
	if miniFATSectors > 0 {
		chain(miniFATStart, miniFATSectors)
		chain(miniStart, miniSectors)
	}
	for index := range items {
		if items[index].mini {
			continue
		}
		items[index].start = uint32(next)
		count := ceil(len(items[index].data))
		chain(next, count)
		big = append(big, append(append([]byte{}, items[index].data...), make([]byte, count*sector-len(items[index].data))...))
		next += count
	}
	entry := func(name string, kind byte, start uint32, size int) []byte {
		raw := make([]byte, 128)
		units := utf16.Encode([]rune(name))
		for position, unit := range units {
			binary.LittleEndian.PutUint16(raw[position*2:], unit)
		}
		binary.LittleEndian.PutUint16(raw[0x40:], uint16((len(units)+1)*2))
		raw[0x42] = kind
		binary.LittleEndian.PutUint32(raw[0x74:], start)
		binary.LittleEndian.PutUint32(raw[0x78:], uint32(size))
		return raw
	}
	rootStart := uint32(0xFFFFFFFE)
	if miniSectors > 0 {
		rootStart = uint32(miniStart)
	}
	directory := entry("Root Entry", 5, rootStart, len(mini))
	for _, item := range items {
		directory = append(directory, entry(item.name, 2, item.start, len(item.data))...)
	}
	directory = append(directory, make([]byte, directorySectors*sector-len(directory))...)
	header := make([]byte, sector)
	copy(header, cfbMagic)
	binary.LittleEndian.PutUint16(header[0x1E:], 9)
	binary.LittleEndian.PutUint16(header[0x20:], 6)
	binary.LittleEndian.PutUint32(header[0x2C:], 1)
	binary.LittleEndian.PutUint32(header[0x30:], 1)
	binary.LittleEndian.PutUint32(header[0x38:], 4096)
	miniFATHeader := uint32(0xFFFFFFFE)
	if miniFATSectors > 0 {
		miniFATHeader = uint32(miniFATStart)
	}
	binary.LittleEndian.PutUint32(header[0x3C:], miniFATHeader)
	binary.LittleEndian.PutUint32(header[0x40:], uint32(miniFATSectors))
	binary.LittleEndian.PutUint32(header[0x44:], 0xFFFFFFFE)
	for index := range 109 {
		binary.LittleEndian.PutUint32(header[0x4C+4*index:], 0xFFFFFFFF)
	}
	binary.LittleEndian.PutUint32(header[0x4C:], 0)
	fatBytes := make([]byte, sector)
	for index, value := range fat {
		binary.LittleEndian.PutUint32(fatBytes[index*4:], value)
	}
	out := append(append(header, fatBytes...), directory...)
	if miniFATSectors > 0 {
		miniFATBytes := make([]byte, miniFATSectors*sector)
		for index := range miniFATBytes {
			miniFATBytes[index] = 0xFF
		}
		for index, value := range miniFAT {
			binary.LittleEndian.PutUint32(miniFATBytes[index*4:], value)
		}
		out = append(out, miniFATBytes...)
		out = append(out, mini...)
		out = append(out, make([]byte, miniSectors*sector-len(mini))...)
	}
	for _, data := range big {
		out = append(out, data...)
	}
	return out
}

func wordHeader(flags uint16) []byte {
	header := make([]byte, 32)
	binary.LittleEndian.PutUint16(header, docIdentifier)
	binary.LittleEndian.PutUint16(header[0x0A:], flags)
	return header
}

func biffRecord(id uint16, payload int) []byte {
	record := make([]byte, 4+payload)
	binary.LittleEndian.PutUint16(record, id)
	binary.LittleEndian.PutUint16(record[2:], uint16(payload))
	return record
}

func currentUser(token uint32) []byte {
	atom := make([]byte, 24)
	binary.LittleEndian.PutUint32(atom[8:], 20)
	binary.LittleEndian.PutUint32(atom[12:], token)
	return atom
}

func mustFormat(t *testing.T, mimeType string) Format {
	t.Helper()
	format, ok := Lookup(mimeType)
	if !ok {
		t.Fatalf("no format for %s", mimeType)
	}
	return format
}

func assertCode(t *testing.T, err error, want string) {
	t.Helper()
	if want == "" {
		if err != nil {
			t.Fatalf("unexpected failure: %v", err)
		}
		return
	}
	var failure *Failure
	if !errors.As(err, &failure) || failure.Code != want {
		t.Fatalf("failure = %v; want code %s", err, want)
	}
}

func TestPrecheck(t *testing.T) {
	filler := bytes.Repeat([]byte{0x41}, 5000)
	cases := []struct {
		name string
		mime string
		data []byte
		want string
	}{
		{"docx valid", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", zipOf(t, map[string]string{"[Content_Types].xml": "<Types/>"}), ""},
		{"docx encrypted", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buildCFB(t, cfbStream{"EncryptionInfo", []byte("info")}, cfbStream{"EncryptedPackage", filler}), CodePasswordProtected},
		{"docx plain text", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", []byte("not a zip"), CodeCorrupt},
		{"docx without content types", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", zipOf(t, map[string]string{"a": "b"}), CodeCorrupt},
		{"docx legacy container", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buildCFB(t, cfbStream{"WordDocument", wordHeader(0)}), CodeCorrupt},
		{"pptx truncated", "application/vnd.openxmlformats-officedocument.presentationml.presentation", zipOf(t, map[string]string{"[Content_Types].xml": string(filler)})[:100], CodeCorrupt},
		{"odt valid", "application/vnd.oasis.opendocument.text", zipOf(t, map[string]string{"mimetype": "x", "META-INF/manifest.xml": "<manifest/>"}), ""},
		{"odt encrypted", "application/vnd.oasis.opendocument.text", zipOf(t, map[string]string{"mimetype": "x", "META-INF/manifest.xml": "<file-entry><encryption-data/></file-entry>"}), CodePasswordProtected},
		{"odp without mimetype", "application/vnd.oasis.opendocument.presentation", zipOf(t, map[string]string{"a": "b"}), CodeCorrupt},
		{"doc valid mini stream", "application/msword", buildCFB(t, cfbStream{"WordDocument", wordHeader(0)}), ""},
		{"doc valid big stream", "application/msword", buildCFB(t, cfbStream{"WordDocument", append(wordHeader(0), filler...)}), ""},
		{"doc encrypted", "application/msword", buildCFB(t, cfbStream{"WordDocument", wordHeader(docEncryptedFlag)}), CodePasswordProtected},
		{"doc wrong identifier", "application/msword", buildCFB(t, cfbStream{"WordDocument", make([]byte, 32)}), CodeCorrupt},
		{"doc not compound", "application/msword", []byte("PK\x03\x04"), CodeCorrupt},
		{"xls valid", "application/vnd.ms-excel", buildCFB(t, cfbStream{"Workbook", append(biffRecord(0x0809, 8), biffRecord(biffEndOfStream, 0)...)}), ""},
		{"xls encrypted", "application/vnd.ms-excel", buildCFB(t, cfbStream{"Workbook", append(append(biffRecord(0x0809, 8), biffRecord(0x00E1, 2)...), biffRecord(biffFilePass, 6)...)}), CodePasswordProtected},
		{"xls without workbook", "application/vnd.ms-excel", buildCFB(t, cfbStream{"Other", []byte("x")}), CodeCorrupt},
		{"ppt valid", "application/vnd.ms-powerpoint", buildCFB(t, cfbStream{"Current User", currentUser(0xE391C05F)}, cfbStream{"PowerPoint Document", filler}), ""},
		{"ppt encrypted", "application/vnd.ms-powerpoint", buildCFB(t, cfbStream{"Current User", currentUser(pptEncryptedToken)}, cfbStream{"PowerPoint Document", filler}), CodePasswordProtected},
		{"ppt without slides", "application/vnd.ms-powerpoint", buildCFB(t, cfbStream{"Current User", currentUser(0xE391C05F)}), CodeCorrupt},
		{"key valid", "application/vnd.apple.keynote", zipOf(t, map[string]string{"Index/Document.iwa": "x"}), ""},
		{"key corrupt", "application/x-iwork-keynote-sffkey", []byte("nope"), CodeCorrupt},
		{"txt valid", "text/plain", []byte("hello"), ""},
		{"txt empty", "text/plain", nil, CodeCorrupt},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assertCode(t, Precheck(mustFormat(t, tc.mime), tc.data), tc.want)
		})
	}
}

func TestPrecheckSurvivesMalformedCompoundFile(t *testing.T) {
	valid := buildCFB(t, cfbStream{"WordDocument", wordHeader(0)})
	for cut := 0; cut < len(valid); cut += 97 {
		_ = Precheck(mustFormat(t, "application/msword"), valid[:cut])
	}
	loop := append([]byte{}, valid...)
	binary.LittleEndian.PutUint32(loop[516:], 1)
	assertCode(t, Precheck(mustFormat(t, "application/msword"), loop), CodeCorrupt)
}

func TestCodeFromMessageRoundTrip(t *testing.T) {
	for _, code := range []string{CodePasswordProtected, CodeCorrupt, CodeTooManyPages, CodeTooLarge, CodeUnsupportedFormat} {
		failure := &Failure{Code: code, Message: "detail"}
		got, ok := CodeFromMessage("isolated office render failed: " + failure.Error())
		if !ok || got != code {
			t.Fatalf("code %s round trip = %q, %v", code, got, ok)
		}
	}
	if _, ok := CodeFromMessage("office_failure=bogus: x"); ok {
		t.Fatal("unknown code accepted")
	}
	if _, ok := CodeFromMessage("plain failure"); ok {
		t.Fatal("plain message produced a code")
	}
}
