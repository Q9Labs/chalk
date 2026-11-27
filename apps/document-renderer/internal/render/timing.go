package render

// ChildTiming is written beside isolated-child output so the parent can
// separate process startup from untrusted-document work without giving the
// child any logging or network authority.
type ChildTiming struct {
	InputReadMs    int64 `json:"input_read_ms"`
	DocumentOpenMs int64 `json:"document_open_ms"`
	InventoryMs    int64 `json:"inventory_ms"`
	PageLoadMs     int64 `json:"page_load_ms"`
	BitmapRenderMs int64 `json:"bitmap_render_ms"`
	BitmapWriteMs  int64 `json:"bitmap_write_ms"`
	TotalMs        int64 `json:"total_ms"`
}
