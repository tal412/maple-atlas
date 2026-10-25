package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/pion/webrtc/v4"
)

// identity is what a phone remembers about this Mac: the session ID, the QR
// secret, the ICE username/password, the DTLS certificate and the UDP port. It is
// saved once a phone has paired, so the same phone reconnects after the app or the
// Mac restarts, without scanning again. The file lives in the app's Application
// Support folder, readable only by this user.
type identity struct {
	Version   int      `json:"version"`
	Session   string   `json:"session"`
	Secret    string   `json:"secret"`
	Ufrag     string   `json:"ufrag"`
	Pwd       string   `json:"pwd"`
	Port      int      `json:"port"`
	CertPEM   string   `json:"certificate"`
	Addresses []string `json:"addresses"`
	Paired    bool     `json:"paired"`

	cert   webrtc.Certificate
	secret []byte
}

func newIdentity() (*identity, error) {
	cert, err := webrtc.GenerateCertificate(mustECDSAKey())
	if err != nil {
		return nil, err
	}
	pem, err := cert.PEM()
	if err != nil {
		return nil, err
	}
	secret := make([]byte, 16)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	return &identity{Version: 1, Session: randomHex(8), Secret: hex.EncodeToString(secret), Ufrag: randomICEString(16),
		Pwd: randomICEString(32), CertPEM: pem, cert: *cert, secret: secret}, nil
}

func identityPath(dir string) string { return filepath.Join(dir, "pairing.json") }

// loadIdentity returns the saved pairing, or nil when there is none or it is unusable.
func loadIdentity(dir string) *identity {
	if dir == "" {
		return nil
	}
	b, err := os.ReadFile(identityPath(dir))
	if err != nil {
		return nil
	}
	var id identity
	if json.Unmarshal(b, &id) != nil || id.Version != 1 || !id.Paired {
		return nil
	}
	secret, err := hex.DecodeString(id.Secret)
	cert, cerr := webrtc.CertificateFromPEM(id.CertPEM)
	if err != nil || len(secret) != 16 || cerr != nil || len(id.Session) != 16 || len(id.Ufrag) < 4 || len(id.Pwd) < 22 {
		return nil
	}
	id.secret, id.cert = secret, *cert
	return &id
}

func (id *identity) save(dir string) error {
	if dir == "" {
		return errors.New("no state directory")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return err
	}
	tmp := identityPath(dir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, identityPath(dir))
}

func forgetIdentity(dir string) {
	if dir != "" {
		_ = os.Remove(identityPath(dir))
	}
}
