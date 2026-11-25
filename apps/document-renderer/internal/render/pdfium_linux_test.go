//go:build linux

package render

import (
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestPDFInventoryFixtures(t *testing.T) {
	for _, tc := range []struct {
		name      string
		pages     int
		landscape bool
		mixed     bool
	}{
		{"normal.pdf", 2, false, false},
		{"image-only.pdf", 1, false, false},
		{"rotated.pdf", 1, true, false},
		{"mixed.pdf", 2, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inventory, failure, err := PDFInventoryFromBytes(fixture(t, tc.name))
			if err != nil {
				t.Fatalf("inventory failure %q: %v", failure, err)
			}
			if inventory.PageCount != tc.pages || len(inventory.Pages) != tc.pages {
				t.Fatalf("inventory = %+v", inventory)
			}
			first := inventory.Pages[0]
			if first.Width < 1 || first.Width > 1600 || first.Height < 1 || first.Height > 1600 {
				t.Fatalf("invalid first dimensions %+v", first)
			}
			if tc.landscape && first.Width <= first.Height {
				t.Fatalf("rotated page did not render as landscape: %+v", first)
			}
			if tc.mixed && inventory.Pages[0].Width == inventory.Pages[1].Width && inventory.Pages[0].Height == inventory.Pages[1].Height {
				t.Fatalf("mixed fixture dimensions collapsed: %+v", inventory.Pages)
			}
		})
	}
}

func TestPDFRejectsEncryptedAndCorruptFixtures(t *testing.T) {
	if _, failure, err := PDFInventoryFromBytes(fixture(t, "encrypted.pdf")); err == nil || failure != "password_protected" {
		t.Fatalf("encrypted failure=%q err=%v", failure, err)
	}
	if _, failure, err := PDFInventoryFromBytes(fixture(t, "corrupt.pdf")); err == nil || failure == "password_protected" {
		t.Fatalf("corrupt failure=%q err=%v", failure, err)
	}
}

func TestRenderPDFPageProducesBitmapAndWebP(t *testing.T) {
	bitmap, width, height, failure, err := RenderPDFPage(fixture(t, "normal.pdf"), 1, 1600)
	if err != nil {
		t.Fatalf("render failure %q: %v", failure, err)
	}
	if width < 1 || height < 1 || len(bitmap) != width*height*4 {
		t.Fatalf("bitmap %dx%d bytes %d", width, height, len(bitmap))
	}
	encoded, err := EncodeWebP(bitmap, width, height, 78)
	if err != nil || len(encoded) < 100 {
		t.Fatalf("webp len=%d err=%v", len(encoded), err)
	}
	if string(encoded[:4]) != "RIFF" || string(encoded[8:12]) != "WEBP" {
		t.Fatal("encoded payload is not a webp RIFF")
	}
}
