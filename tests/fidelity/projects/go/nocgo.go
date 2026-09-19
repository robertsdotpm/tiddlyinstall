//go:build !cgo

package main

// Built without cgo (CGO_ENABLED=0, or no C compiler found): this program
// doesn't need it, so this is only reported.
func cgoCheck() (string, error) { return "off (not needed by this program)", nil }
