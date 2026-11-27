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

func pptx(t *testing.T, slides int) []byte {
	const ns = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`
	rel := func(id, kind, target string) string {
		return `<Relationship Id="` + id + `" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/` + kind + `" Target="` + target + `"/>`
	}
	rels := func(items ...string) string {
		return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` + strings.Join(items, "") + `</Relationships>`
	}
	override := func(part, kind string) string {
		return `<Override PartName="` + part + `" ContentType="application/vnd.openxmlformats-officedocument.` + kind + `+xml"/>`
	}
	emptyTree := `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>`
	files := map[string]string{
		"_rels/.rels":                                  rels(rel("rId1", "officeDocument", "ppt/presentation.xml")),
		"ppt/_rels/presentation.xml.rels":              "",
		"ppt/slideMasters/slideMaster1.xml":            `<?xml version="1.0"?><p:sldMaster ` + ns + `>` + emptyTree + `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
		"ppt/slideMasters/_rels/slideMaster1.xml.rels": rels(rel("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"), rel("rId2", "theme", "../theme/theme1.xml")),
		"ppt/slideLayouts/slideLayout1.xml":            `<?xml version="1.0"?><p:sldLayout ` + ns + ` type="blank">` + emptyTree + `</p:sldLayout>`,
		"ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels(rel("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")),
		"ppt/theme/theme1.xml":                         `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="t"><a:themeElements><a:clrScheme name="c"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="333333"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="FF0000"/></a:accent1><a:accent2><a:srgbClr val="00FF00"/></a:accent2><a:accent3><a:srgbClr val="0000FF"/></a:accent3><a:accent4><a:srgbClr val="FFFF00"/></a:accent4><a:accent5><a:srgbClr val="FF00FF"/></a:accent5><a:accent6><a:srgbClr val="00FFFF"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="m"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
	}
	types := override("/ppt/presentation.xml", "presentationml.presentation.main") + override("/ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster") + override("/ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout") + override("/ppt/theme/theme1.xml", "theme")
	presentationRels := []string{rel("rId1", "slideMaster", "slideMasters/slideMaster1.xml")}
	var slideIDs strings.Builder
	for slide := 1; slide <= slides; slide++ {
		part := fmt.Sprintf("ppt/slides/slide%d.xml", slide)
		files[part] = `<?xml version="1.0"?><p:sld ` + ns + `><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="6400000" cy="1200000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="3366CC"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" sz="4000"/><a:t>Slide ` + fmt.Sprint(slide) + `</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
		files[fmt.Sprintf("ppt/slides/_rels/slide%d.xml.rels", slide)] = rels(rel("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"))
		types += override("/"+part, "presentationml.slide")
		presentationRels = append(presentationRels, rel(fmt.Sprintf("rId%d", slide+1), "slide", fmt.Sprintf("slides/slide%d.xml", slide)))
		fmt.Fprintf(&slideIDs, `<p:sldId id="%d" r:id="rId%d"/>`, 255+slide, slide+1)
	}
	files["ppt/_rels/presentation.xml.rels"] = rels(presentationRels...)
	files["ppt/presentation.xml"] = `<?xml version="1.0"?><p:presentation ` + ns + `><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>` + slideIDs.String() + `</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
	files["[Content_Types].xml"] = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` + types + `</Types>`
	return zipOf(t, files)
}

func TestIntegrationPptx(t *testing.T) {
	pdf, err := convertToPDF(t, "application/vnd.openxmlformats-officedocument.presentationml.presentation", pptx(t, 3))
	if err != nil {
		t.Fatal(err)
	}
	if got := pageCount(pdf); got != 3 {
		t.Fatalf("pptx pages = %d; want 3", got)
	}
	if inkedPixels(t, pdf) == 0 {
		t.Fatal("pptx first slide is blank")
	}
}
