package office

import (
	"sort"
	"testing"
)

func TestFormatTable(t *testing.T) {
	want := map[string]string{
		"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
		"application/vnd.ms-powerpoint":                                             "ppt",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document":   "docx",
		"application/msword": "doc",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
		"application/vnd.ms-excel":                        "xls",
		"application/vnd.oasis.opendocument.presentation": "odp",
		"application/vnd.oasis.opendocument.text":         "odt",
		"application/vnd.oasis.opendocument.spreadsheet":  "ods",
		"text/plain":                         "txt",
		"application/vnd.apple.keynote":      "key",
		"application/x-iwork-keynote-sffkey": "key",
	}
	got := MIMETypes()
	sort.Strings(got)
	if len(got) != len(want) {
		t.Fatalf("table has %d types; want %d", len(got), len(want))
	}
	for mimeType, extension := range want {
		format, ok := Lookup(mimeType)
		if !ok || format.Extension != extension {
			t.Fatalf("%s = %+v, %v; want extension %s", mimeType, format, ok, extension)
		}
	}
}

func TestSpreadsheetAndKeynoteFlags(t *testing.T) {
	for mimeType, format := range formats {
		spreadsheet := format.Extension == "xlsx" || format.Extension == "xls" || format.Extension == "ods"
		if format.Spreadsheet != spreadsheet {
			t.Fatalf("%s spreadsheet = %v", mimeType, format.Spreadsheet)
		}
		if format.Keynote != (format.Extension == "key") {
			t.Fatalf("%s keynote = %v", mimeType, format.Keynote)
		}
	}
}

func TestPDFAndImagesAreNotOfficeTypes(t *testing.T) {
	for _, mimeType := range []string{"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", ""} {
		if _, ok := Lookup(mimeType); ok {
			t.Fatalf("%q must not be an office type", mimeType)
		}
	}
}
