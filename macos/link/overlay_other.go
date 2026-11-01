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
func overlayLookCard(map[string]any)           {}
func overlayLookProgress(map[string]any)       {}
func overlayStart()                            {}
func lookSetup(string, string)                 {}

// lookSession is used by the Windows Look overlay only.
var lookSession = func() *session { return nil }

// atlasWindowAt is used by the Windows pop-up shortcut (atlas_popup_windows.go) only.
func atlasWindowAt(url, dir string) {}
