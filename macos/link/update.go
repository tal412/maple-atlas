package main

// Updates for the Windows app: compare this build with the latest GitHub release,
// download its setup program and start it. The setup closes the running app,
// installs over it and opens the new version. Only GitHub is contacted, and only
// when checking for or downloading an update.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// version is set at build time: -ldflags "-X main.version=0.3.0".
var version = "dev"

const (
	releaseAPI = "https://api.github.com/repos/tal412/maple-atlas/releases/latest"
	setupName  = "MapleAtlasCompanion-Setup.exe"
)

type releaseAsset struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	Size   int64  `json:"size"`
	Digest string `json:"digest"` // "sha256:<hex>"
}

type release struct {
	Tag    string         `json:"tag_name"`
	Page   string         `json:"html_url"`
	Assets []releaseAsset `json:"assets"`
}

// releaseVersion turns "companion-v0.3.0" into "0.3.0".
func releaseVersion(tag string) string {
	tag = strings.TrimPrefix(tag, "companion-")
	return strings.TrimPrefix(tag, "v")
}

// newerVersion reports whether a is a later x.y.z than b. A "dev" build never asks to update.
func newerVersion(a, b string) bool {
	if b == "dev" || b == "" {
		return false
	}
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}

var updateClient = &http.Client{Timeout: 10 * time.Minute}

func latestRelease() (*release, error) {
	req, _ := http.NewRequest(http.MethodGet, releaseAPI, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "MapleAtlasCompanion/"+version)
	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub answered %s", res.Status)
	}
	var r release
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&r); err != nil {
		return nil, err
	}
	return &r, nil
}

func (r *release) asset(name string) *releaseAsset {
	for i := range r.Assets {
		if r.Assets[i].Name == name {
			return &r.Assets[i]
		}
	}
	return nil
}

// downloadAsset saves the file to the temp folder and checks its size and SHA-256.
func downloadAsset(a *releaseAsset, ver string) (string, error) {
	if !strings.HasPrefix(a.URL, "https://github.com/tal412/maple-atlas/releases/download/") {
		return "", errors.New("unexpected download address")
	}
	res, err := updateClient.Get(a.URL)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download failed: %s", res.Status)
	}
	path := filepath.Join(os.TempDir(), strings.TrimSuffix(a.Name, ".exe")+"-"+ver+".exe")
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	sum := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, sum), io.LimitReader(res.Body, 500<<20))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && a.Size > 0 && n != a.Size {
		err = errors.New("the download was incomplete")
	}
	if want := strings.TrimPrefix(a.Digest, "sha256:"); err == nil && want != "" && !strings.EqualFold(want, hex.EncodeToString(sum.Sum(nil))) {
		err = errors.New("the download did not match the release")
	}
	if err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

// startInstaller opens the setup program through the shell, so Windows can ask for
// administrator approval.
func startInstaller(path string) error {
	if runtime.GOOS != "windows" {
		return errors.New("updates install this way only on Windows")
	}
	return exec.Command("cmd", "/c", "start", "", path).Start()
}
