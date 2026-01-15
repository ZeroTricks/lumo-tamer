package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"syscall"
	"time"

	"github.com/henrybear327/go-proton-api"
	"golang.org/x/term"
)

// AuthResult is the JSON output structure
type AuthResult struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	UID          string `json:"uid"`
	UserID       string `json:"userID"`
	KeyPassword  string `json:"keyPassword"`
	ExpiresAt    string `json:"expiresAt,omitempty"`
	Error        string `json:"error,omitempty"`
	ErrorCode    int    `json:"errorCode,omitempty"`
}

func main() {
	// Parse command line flags
	outputPath := flag.String("o", "", "Output file path (if not specified, outputs to stdout)")
	flag.Parse()

	result := authenticate()

	// Output JSON
	output, _ := json.MarshalIndent(result, "", "  ")

	if *outputPath != "" {
		err := os.WriteFile(*outputPath, output, 0600)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error writing to file: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "Auth tokens written to %s\n", *outputPath)
	} else {
		fmt.Println(string(output))
	}

	if result.Error != "" {
		os.Exit(1)
	}
}

func authenticate() AuthResult {
	reader := bufio.NewReader(os.Stdin)

	// Prompt for username
	fmt.Fprint(os.Stderr, "Proton username (email): ")
	username, err := reader.ReadString('\n')
	if err != nil {
		return AuthResult{Error: "Failed to read username", ErrorCode: 1000}
	}
	username = strings.TrimSpace(username)

	// Prompt for password (hidden input)
	fmt.Fprint(os.Stderr, "Password: ")
	passwordBytes, err := term.ReadPassword(int(syscall.Stdin))
	fmt.Fprintln(os.Stderr) // newline after password
	if err != nil {
		return AuthResult{Error: "Failed to read password", ErrorCode: 1000}
	}
	password := string(passwordBytes)

	// Create Proton API manager
	// Use default host URL (https://mail.proton.me/api) - don't override it
	ctx := context.Background()
	manager := proton.New(
		proton.WithAppVersion("web-lumo@5.0.0"),
	)
	defer manager.Close()

	// Perform SRP authentication
	client, auth, err := manager.NewClientWithLogin(ctx, username, []byte(password))
	if err != nil {
		return AuthResult{
			Error:     fmt.Sprintf("Authentication failed: %v", err),
			ErrorCode: 1001,
		}
	}
	defer client.Close()

	// Check if 2FA is required
	if auth.TwoFA.Enabled != 0 {
		fmt.Fprint(os.Stderr, "2FA TOTP code: ")
		totp, err := reader.ReadString('\n')
		if err != nil {
			return AuthResult{Error: "Failed to read TOTP", ErrorCode: 1002}
		}
		totp = strings.TrimSpace(totp)

		err = client.Auth2FA(ctx, proton.Auth2FAReq{TwoFactorCode: totp})
		if err != nil {
			return AuthResult{
				Error:     fmt.Sprintf("2FA failed: %v", err),
				ErrorCode: 1003,
			}
		}
	}

	// Get user info to find the primary key ID
	user, err := client.GetUser(ctx)
	if err != nil {
		return AuthResult{
			Error:     fmt.Sprintf("Failed to get user: %v", err),
			ErrorCode: 1006,
		}
	}

	// Get salts - this is available in a time-limited window after auth
	salts, err := client.GetSalts(ctx)
	if err != nil {
		return AuthResult{
			Error:     fmt.Sprintf("Failed to get salts: %v", err),
			ErrorCode: 1007,
		}
	}

	// Derive the key password using the primary key's salt
	primaryKey := user.Keys.Primary()
	keyPassword, err := salts.SaltForKey([]byte(password), primaryKey.ID)
	if err != nil {
		return AuthResult{
			Error:     fmt.Sprintf("Failed to derive key password: %v", err),
			ErrorCode: 1007,
		}
	}

	// Calculate expiry (tokens typically last ~24 hours, but we'll be conservative)
	expiresAt := time.Now().Add(12 * time.Hour).UTC().Format(time.RFC3339)

	return AuthResult{
		AccessToken:  auth.AccessToken,
		RefreshToken: auth.RefreshToken,
		UID:          auth.UID,
		UserID:       auth.UserID,
		KeyPassword:  string(keyPassword),
		ExpiresAt:    expiresAt,
	}
}
