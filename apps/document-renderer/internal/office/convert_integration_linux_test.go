//go:build officeintegration

package office

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var pdfPage = regexp.MustCompile(`/Type\s*/Page[^s]`)

func integrationConfig(t *testing.T) Config {
	t.Helper()
	config := ConfigFromEnv()
	if config.Soffice == "" {
		config.Soffice = "/usr/bin/soffice"
	}
	if config.Driver == "" {
		config.Driver = filepath.Join("..", "..", "office", "office_convert.py")
	}
	if _, err := os.Stat(config.Soffice); err != nil {
		t.Skipf("soffice is not installed: %v", err)
	}
	config.KeynoteOn = true
	return config
}

func convertToPDF(t *testing.T, mimeType string, input []byte) ([]byte, error) {
	t.Helper()
	output := filepath.Join(t.TempDir(), "out.pdf")
	if err := Convert(context.Background(), integrationConfig(t), mimeType, input, filepath.Join(t.TempDir(), "office"), output); err != nil {
		return nil, err
	}
	return os.ReadFile(output)
}

func pageCount(pdf []byte) int { return len(pdfPage.FindAll(pdf, -1)) }

func inkedPixels(t *testing.T, pdf []byte) int {
	t.Helper()
	if _, err := exec.LookPath("pdftoppm"); err != nil {
		t.Skip("pdftoppm is not installed")
	}
	source := filepath.Join(t.TempDir(), "in.pdf")
	if err := os.WriteFile(source, pdf, 0o600); err != nil {
		t.Fatal(err)
	}
	rendered, err := exec.Command("pdftoppm", "-png", "-r", "50", "-f", "1", "-l", "1", "-singlefile", source).Output()
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := png.Decode(bytes.NewReader(rendered))
	if err != nil {
		t.Fatal(err)
	}
	inked := 0
	bounds := decoded.Bounds()
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			if r, g, b, _ := decoded.At(x, y).RGBA(); r < 0xA000 || g < 0xA000 || b < 0xA000 {
				inked++
			}
		}
	}
	return inked
}

func wordDocument(paragraphs ...string) string {
	var body strings.Builder
	for _, paragraph := range paragraphs {
		body.WriteString(paragraph)
	}
	return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` + body.String() + `</w:body></w:document>`
}

func docx(t *testing.T, paragraphs ...string) []byte {
	return zipOf(t, map[string]string{
		"[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"_rels/.rels":         `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		"word/document.xml":   wordDocument(paragraphs...),
	})
}

func paragraph(text string) string {
	return `<w:p><w:r><w:t>` + text + `</w:t></w:r></w:p>`
}

const pageBreak = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`

func rtlParagraph(font, text string) string {
	return `<w:p><w:pPr><w:bidi/><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:rFonts w:cs="` + font + `"/><w:sz w:val="72"/><w:szCs w:val="72"/><w:rtl/></w:rPr><w:t>` + text + `</w:t></w:r></w:p>`
}

func xlsx(t *testing.T, rows, columns int) []byte {
	var sheet strings.Builder
	sheet.WriteString(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for row := 1; row <= rows; row++ {
		fmt.Fprintf(&sheet, `<row r="%d">`, row)
		for column := range columns {
			fmt.Fprintf(&sheet, `<c r="%c%d"><v>%d</v></c>`, 'A'+column%26, row, row*column)
		}
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData></worksheet>`)
	return zipOf(t, map[string]string{
		"[Content_Types].xml":        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
		"_rels/.rels":                `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		"xl/workbook.xml":            `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
		"xl/worksheets/sheet1.xml":   sheet.String(),
	})
}

func odf(t *testing.T, mimeType, content string) []byte {
	return zipOf(t, map[string]string{
		"mimetype":              mimeType,
		"META-INF/manifest.xml": `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="` + mimeType + `"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
		"content.xml":           content,
	})
}

const odfNamespaces = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2"`

func odp(t *testing.T, slides int) []byte {
	var body strings.Builder
	for slide := 1; slide <= slides; slide++ {
		fmt.Fprintf(&body, `<draw:page draw:name="s%d"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="4cm"><draw:text-box><text:p>Slide %d headline</text:p></draw:text-box></draw:frame></draw:page>`, slide, slide)
	}
	return odf(t, "application/vnd.oasis.opendocument.presentation", `<?xml version="1.0"?><office:document-content `+odfNamespaces+`><office:body><office:presentation>`+body.String()+`</office:presentation></office:body></office:document-content>`)
}

func odt(t *testing.T, text string) []byte {
	return odf(t, "application/vnd.oasis.opendocument.text", `<?xml version="1.0"?><office:document-content `+odfNamespaces+`><office:body><office:text><text:p>`+text+`</text:p></office:text></office:body></office:document-content>`)
}

func TestIntegrationDocx(t *testing.T) {
	pdf, err := convertToPDF(t, docxMIME, docx(t, paragraph("First page"), pageBreak, paragraph("Second page"), pageBreak, paragraph("Third page")))
	if err != nil {
		t.Fatal(err)
	}
	if got := pageCount(pdf); got != 3 {
		t.Fatalf("pages = %d; want 3", got)
	}
	if inkedPixels(t, pdf) == 0 {
		t.Fatal("first page is blank")
	}
}

func TestIntegrationOpenDocument(t *testing.T) {
	pdf, err := convertToPDF(t, "application/vnd.oasis.opendocument.presentation", odp(t, 4))
	if err != nil {
		t.Fatal(err)
	}
	if got := pageCount(pdf); got != 4 {
		t.Fatalf("odp pages = %d; want 4", got)
	}
	if inkedPixels(t, pdf) == 0 {
		t.Fatal("odp first page is blank")
	}
	pdf, err = convertToPDF(t, "application/vnd.oasis.opendocument.text", odt(t, "Hello from a text document"))
	if err != nil || pageCount(pdf) != 1 {
		t.Fatalf("odt pages = %d, err = %v", pageCount(pdf), err)
	}
}

func TestIntegrationPlainText(t *testing.T) {
	pdf, err := convertToPDF(t, "text/plain", []byte("plain text line\nsecond line\n"))
	if err != nil {
		t.Fatal(err)
	}
	if pageCount(pdf) != 1 || inkedPixels(t, pdf) == 0 {
		t.Fatalf("txt pages = %d", pageCount(pdf))
	}
}

func TestIntegrationSpreadsheetFitsOnePageWide(t *testing.T) {
	pdf, err := convertToPDF(t, xlsxMIME, xlsx(t, 5, 40))
	if err != nil {
		t.Fatal(err)
	}
	if got := pageCount(pdf); got != 1 {
		t.Fatalf("a 5x40 sheet takes %d pages; want 1 (fit to one page width)", got)
	}
	if inkedPixels(t, pdf) == 0 {
		t.Fatal("sheet page is blank")
	}
}

func TestIntegrationSpreadsheetExportIsCapped(t *testing.T) {
	pdf, err := convertToPDF(t, xlsxMIME, xlsx(t, 30000, 3))
	if err != nil {
		t.Fatal(err)
	}
	if got := pageCount(pdf); got != ExportPageLimit {
		t.Fatalf("export has %d pages; want exactly %d", got, ExportPageLimit)
	}
}

func TestIntegrationRTLScripts(t *testing.T) {
	for name, tc := range map[string]struct{ font, text string }{
		"arabic": {"Noto Naskh Arabic", "مرحبا بالعالم، هذا عرض تجريبي"},
		"urdu":   {"Noto Nastaliq Urdu", "یہ ایک آزمائشی دستاویز ہے"},
	} {
		t.Run(name, func(t *testing.T) {
			pdf, err := convertToPDF(t, docxMIME, docx(t, rtlParagraph(tc.font, tc.text)))
			if err != nil {
				t.Fatal(err)
			}
			if inkedPixels(t, pdf) < 200 {
				t.Fatal("RTL page is blank")
			}
			if _, err := exec.LookPath("pdffonts"); err != nil {
				return
			}
			source := filepath.Join(t.TempDir(), "in.pdf")
			if err := os.WriteFile(source, pdf, 0o600); err != nil {
				t.Fatal(err)
			}
			fonts, err := exec.Command("pdffonts", source).Output()
			if err != nil || !strings.Contains(string(fonts), "Noto") {
				t.Fatalf("no bundled Noto font was embedded: %v\n%s", err, fonts)
			}
		})
	}
}
