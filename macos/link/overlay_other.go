//go:build !(desktopui && windows)

package main

// The on-game navigation overlay is drawn by the Windows app's helper only; the Mac app
// draws its own (Overlay.swift) from the "nav" events this helper prints.
func overlayNav(map[string]any)                {}
func overlayPins(map[string]any)               {}
func overlayPosition(string, float64, float64) {}
func overlayWindow(string)                     {}
func overlayEnabled(bool)                      {}
func overlayTracking(string)                   {}
