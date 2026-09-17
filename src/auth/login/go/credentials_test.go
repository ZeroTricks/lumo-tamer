package main

import "testing"

func TestFirstNonEmptyTrimsNonSecretInput(t *testing.T) {
	if got := firstNonEmpty("  ", "  user@example.test  "); got != "user@example.test" {
		t.Fatalf("firstNonEmpty() = %q", got)
	}
}

func TestFirstNonEmptyExactPreservesPasswordWhitespace(t *testing.T) {
	if got := firstNonEmptyExact("", "  password with spaces  "); got != "  password with spaces  " {
		t.Fatalf("firstNonEmptyExact() = %q", got)
	}
}
