package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

// generateTOTP computes an RFC 6238 TOTP code (SHA-1, 6 digits, 30s step)
// from a base32-encoded secret, matching Proton Authenticator / Google
// Authenticator defaults. Spaces and padding in the secret are tolerated.
func generateTOTP(secret string, now time.Time) string {
	clean := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(secret), " ", ""))
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(clean)
	if err != nil {
		// Retry tolerating stray '=' padding.
		key, err = base32.StdEncoding.DecodeString(clean)
		if err != nil {
			return ""
		}
	}

	counter := uint64(now.Unix()) / 30
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)

	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)

	offset := sum[len(sum)-1] & 0x0f
	bin := (uint32(sum[offset])&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])
	return fmt.Sprintf("%06d", bin%1_000_000)
}
