package office

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
)

const (
	biffFilePass        = 0x002F
	biffEndOfStream     = 0x000A
	pptEncryptedToken   = 0xF3D1C4DF
	docEncryptedFlag    = 0x0100
	docIdentifier       = 0xA5EC
	maxManifestBytes    = 1 << 20
	maxBIFFPrefixBytes  = 4096
	maxBIFFPrefixRecord = 64
)

var biffBOF = map[uint16]bool{0x0809: true, 0x0409: true, 0x0209: true, 0x0009: true}

func Precheck(format Format, data []byte) error {
	if len(data) == 0 {
		return &Failure{Code: CodeCorrupt, Message: "document is empty"}
	}
	switch format.Container {
	case ContainerText:
		return nil
	case ContainerOOXML:
		return precheckOOXML(data)
	case ContainerODF:
		return precheckODF(data)
	case ContainerZip:
		_, err := openZip(data)
		return err
	}
	return precheckLegacy(format, data)
}

func corrupt(format string, args ...any) error {
	return &Failure{Code: CodeCorrupt, Message: fmt.Sprintf(format, args...)}
}

func openZip(data []byte) (*zip.Reader, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, corrupt("document is not a valid zip package: %v", err)
	}
	return reader, nil
}

func zipEntry(reader *zip.Reader, name string) *zip.File {
	for _, file := range reader.File {
		if file.Name == name {
			return file
		}
	}
	return nil
}

func passwordProtected() error {
	return &Failure{Code: CodePasswordProtected, Message: "document is password protected"}
}

func precheckOOXML(data []byte) error {
	if isCFB(data) {
		container, err := openCFB(data)
		if err != nil {
			return corrupt("document container is malformed")
		}
		if container.has("EncryptedPackage") {
			return passwordProtected()
		}
		return corrupt("document is not an Office Open XML package")
	}
	reader, err := openZip(data)
	if err != nil {
		return err
	}
	if zipEntry(reader, "[Content_Types].xml") == nil {
		return corrupt("document has no content types part")
	}
	return nil
}

func precheckODF(data []byte) error {
	reader, err := openZip(data)
	if err != nil {
		return err
	}
	if zipEntry(reader, "mimetype") == nil {
		return corrupt("document has no mimetype entry")
	}
	manifest := zipEntry(reader, "META-INF/manifest.xml")
	if manifest == nil {
		return nil
	}
	opened, err := manifest.Open()
	if err != nil {
		return corrupt("document manifest cannot be read")
	}
	defer opened.Close()
	content, err := io.ReadAll(io.LimitReader(opened, maxManifestBytes))
	if err != nil {
		return corrupt("document manifest cannot be read")
	}
	if bytes.Contains(content, []byte("encryption-data")) {
		return passwordProtected()
	}
	return nil
}

func precheckLegacy(format Format, data []byte) error {
	if !isCFB(data) {
		return corrupt("document is not a compound file")
	}
	container, err := openCFB(data)
	if err != nil {
		return corrupt("document container is malformed")
	}
	if container.has("EncryptedPackage") {
		return passwordProtected()
	}
	switch format.Extension {
	case "doc":
		return precheckDOC(container)
	case "xls":
		return precheckXLS(container)
	case "ppt":
		return precheckPPT(container)
	}
	return nil
}

func precheckDOC(container *cfbFile) error {
	header, found, err := container.stream("WordDocument", 32)
	if err != nil || !found || len(header) < 12 || binary.LittleEndian.Uint16(header) != docIdentifier {
		return corrupt("document has no valid Word stream")
	}
	if binary.LittleEndian.Uint16(header[0x0A:])&docEncryptedFlag != 0 {
		return passwordProtected()
	}
	return nil
}

func precheckXLS(container *cfbFile) error {
	stream, found, err := container.stream("Workbook", maxBIFFPrefixBytes)
	if err == nil && !found {
		stream, found, err = container.stream("Book", maxBIFFPrefixBytes)
	}
	if err != nil || !found || len(stream) < 4 || !biffBOF[binary.LittleEndian.Uint16(stream)] {
		return corrupt("document has no valid workbook stream")
	}
	position := 0
	for range maxBIFFPrefixRecord {
		if position+4 > len(stream) {
			return nil
		}
		id := binary.LittleEndian.Uint16(stream[position:])
		switch id {
		case biffFilePass:
			return passwordProtected()
		case biffEndOfStream:
			return nil
		}
		position += 4 + int(binary.LittleEndian.Uint16(stream[position+2:]))
	}
	return nil
}

func precheckPPT(container *cfbFile) error {
	if !container.has("PowerPoint Document") {
		return corrupt("document has no PowerPoint stream")
	}
	current, found, err := container.stream("Current User", 16)
	if err != nil || !found || len(current) < 16 {
		return corrupt("document has no current user stream")
	}
	if binary.LittleEndian.Uint32(current[12:]) == pptEncryptedToken {
		return passwordProtected()
	}
	return nil
}
