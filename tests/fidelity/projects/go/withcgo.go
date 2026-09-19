//go:build cgo

package main

func cgoCheck() (string, error) { return "on (not needed by this program)", nil }
