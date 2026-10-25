package main

import "testing"

func TestVersions(t *testing.T) {
	if releaseVersion("companion-v0.3.0") != "0.3.0" {
		t.Fatal("tag parse")
	}
	cases := []struct {
		a, b string
		want bool
	}{{"0.3.1", "0.3.0", true}, {"0.10.0", "0.9.9", true}, {"0.3.0", "0.3.0", false}, {"0.2.9", "0.3.0", false}, {"1.0", "0.9.9", true}, {"0.4.0", "dev", false}}
	for _, c := range cases {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q,%q)=%v", c.a, c.b, got)
		}
	}
}
