//go:build !linux

package render

func applyChildRlimits() error { return nil }
