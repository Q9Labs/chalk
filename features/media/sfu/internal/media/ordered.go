package media

import (
	"container/list"
	"iter"
)

// orderedTable is a map that remembers insertion order, so the oldest entries go first when a
// caller must make room. It never evicts on its own except through Remember. The owner's lock
// guards it.
type orderedTable[K comparable, V any] struct {
	limit int
	items map[K]*list.Element
	order list.List
}

type tableEntry[K comparable, V any] struct {
	key   K
	value V
}

func newOrderedTable[K comparable, V any](limit int) *orderedTable[K, V] {
	return &orderedTable[K, V]{limit: limit, items: map[K]*list.Element{}}
}

func (t *orderedTable[K, V]) Len() int { return len(t.items) }

// Full reports whether the table holds its limit.
func (t *orderedTable[K, V]) Full() bool { return len(t.items) >= t.limit }

func (t *orderedTable[K, V]) Get(key K) (V, bool) {
	element, ok := t.items[key]
	if !ok {
		var zero V
		return zero, false
	}
	return element.Value.(*tableEntry[K, V]).value, true
}

// Put stores the value. A new key becomes the newest entry; a known key keeps its place.
func (t *orderedTable[K, V]) Put(key K, value V) {
	if element, ok := t.items[key]; ok {
		element.Value.(*tableEntry[K, V]).value = value
		return
	}
	t.items[key] = t.order.PushBack(&tableEntry[K, V]{key: key, value: value})
}

// Remember is Put for a table that forgets its oldest entry to stay within the limit, and reports
// the entry it forgot.
func (t *orderedTable[K, V]) Remember(key K, value V) (forgotKey K, forgotValue V, forgot bool) {
	t.Put(key, value)
	if len(t.items) <= t.limit {
		return forgotKey, forgotValue, false
	}
	oldest := t.order.Front().Value.(*tableEntry[K, V])
	t.Delete(oldest.key)
	return oldest.key, oldest.value, true
}

func (t *orderedTable[K, V]) Delete(key K) {
	if element, ok := t.items[key]; ok {
		t.order.Remove(element)
		delete(t.items, key)
	}
}

// All yields the entries oldest first. Deleting the entry just yielded is safe.
func (t *orderedTable[K, V]) All() iter.Seq2[K, V] {
	return func(yield func(K, V) bool) {
		for element := t.order.Front(); element != nil; {
			next := element.Next()
			entry := element.Value.(*tableEntry[K, V])
			if !yield(entry.key, entry.value) {
				return
			}
			element = next
		}
	}
}
