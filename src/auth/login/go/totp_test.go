package main

import (
	"testing"
	"time"
)

func TestGenerateTOTP(t *testing.T) {
	// RFC 6238 test secret, truncated to the six digits used by Proton and
	// common authenticator applications.
	const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	tests := []struct {
		unix int64
		want string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1234567890, "005924"},
	}

	for _, test := range tests {
		if got := generateTOTP(secret, time.Unix(test.unix, 0)); got != test.want {
			t.Errorf("generateTOTP(%d) = %q, want %q", test.unix, got, test.want)
		}
	}
}

func TestGenerateTOTPAcceptsSpacesAndPadding(t *testing.T) {
	now := time.Unix(59, 0)
	want := generateTOTP("MZXW6", now)
	if got := generateTOTP("mz xw6===", now); got != want || got == "" {
		t.Fatalf("generateTOTP() = %q, want %q", got, want)
	}
}

func TestGenerateTOTPRejectsInvalidSecret(t *testing.T) {
	if got := generateTOTP("not valid!", time.Unix(59, 0)); got != "" {
		t.Fatalf("generateTOTP() = %q", got)
	}
}
