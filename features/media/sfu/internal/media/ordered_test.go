package media

import "testing"

func TestOrderedTableForgetsTheOldestAndKeepsPlaceOnUpdate(t *testing.T) {
	table := newOrderedTable[string, int](2)
	table.Remember("a", 1)
	table.Remember("b", 2)
	table.Remember("a", 10) // an update keeps a the oldest
	key, value, forgot := table.Remember("c", 3)
	if !forgot || key != "a" || value != 10 {
		t.Fatalf("forgot %q=%d (%t), want the oldest entry a=10", key, value, forgot)
	}
	if _, ok := table.Get("a"); ok || table.Len() != 2 {
		t.Fatalf("table holds %d entries and still has a", table.Len())
	}
	var order []string
	for key := range table.All() {
		order = append(order, key)
	}
	if len(order) != 2 || order[0] != "b" || order[1] != "c" {
		t.Fatalf("entries in order %v, want [b c]", order)
	}
}

func TestOrderedTableAllowsDeletingWhileWalking(t *testing.T) {
	table := newOrderedTable[int, struct{}](10)
	for i := range 5 {
		table.Put(i, struct{}{})
	}
	for key := range table.All() {
		if key%2 == 0 {
			table.Delete(key)
		}
	}
	if table.Len() != 2 {
		t.Fatalf("%d entries left, want the 2 odd ones", table.Len())
	}
}
