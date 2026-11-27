//go:build !linux

package render

func applyChildRlimits(string) error { return nil }
