package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
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

// Default values for headers (can be overridden via CLI flags)
const (
	defaultAppVersion = "macos-drive@1.0.0-alpha.1+rclone"
	defaultUserAgent  = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

func main() {
	// Parse command line flags
	outputPath := flag.String("o", "", "Output file path (if not specified, outputs to stdout)")
	username := flag.String("username", "", "Proton username (email); non-interactive when set (env PROTON_AUTH_USERNAME)")
	password := flag.String("password", "", "Proton password; non-interactive when set (env PROTON_AUTH_PASSWORD)")
	totpCode := flag.String("totp", "", "Current TOTP code for 2FA (env PROTON_AUTH_TOTP)")
	totpSecret := flag.String("totp-secret", "", "Base32 TOTP secret to auto-generate 2FA codes (env PROTON_AUTH_TOTP_SECRET)")
	appVersion := flag.String("app-version", defaultAppVersion, "X-PM-AppVersion header value")
	userAgent := flag.String("user-agent", defaultUserAgent, "User-Agent header value")
	captchaAutoOpen := flag.Bool("captcha-auto-open", true, "Open the browser automatically when a CAPTCHA is required")
	captchaTest := flag.Bool("captcha-test", false, "Open Proton's CAPTCHA in a browser without logging in (smoke test), then exit")
	proxyURL := flag.String("proxy", "", "Route Proton requests (login and CAPTCHA solve) through this proxy, e.g. http://user:pass@host:port, so they share one IP")
	flag.Parse()

	if *captchaTest {
		os.Exit(runCaptchaTest())
	}

	creds := credentials{
		username:   firstNonEmpty(*username, os.Getenv("PROTON_AUTH_USERNAME")),
		password:   firstNonEmptyExact(*password, os.Getenv("PROTON_AUTH_PASSWORD")),
		totpCode:   firstNonEmpty(*totpCode, os.Getenv("PROTON_AUTH_TOTP")),
		totpSecret: firstNonEmpty(*totpSecret, os.Getenv("PROTON_AUTH_TOTP_SECRET")),
	}

	result := authenticate(*appVersion, *userAgent, *proxyURL, *captchaAutoOpen, creds)

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

// credentials carry optional non-interactive login inputs. When username and
// password are both set the stdin prompts are skipped entirely; 2FA is then
// satisfied from totpCode or auto-generated from totpSecret (base32).
// Environment fallbacks: PROTON_AUTH_USERNAME / PROTON_AUTH_PASSWORD /
// PROTON_AUTH_TOTP / PROTON_AUTH_TOTP_SECRET.
type credentials struct {
	username   string
	password   string
	totpCode   string
	totpSecret string
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// firstNonEmptyExact keeps credential bytes intact. Passwords may legitimately
// begin or end with whitespace, so they must not use firstNonEmpty's trimming.
func firstNonEmptyExact(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// login performs SRP authentication. If Proton demands human verification
// (Code=9001) and offers a CAPTCHA, it lets the user solve it in a browser and
// retries once with the verification token attached. A non-empty proxyURL
// routes every Proton request through the proxy, so the whole exchange comes
// from the IP the HumanVerificationToken was issued to.
// The default host (mail.proton.me/api) is assumed here and by the CAPTCHA
// proxy's hardcoded mail-api.proton.me sibling, so don't override it.
func login(ctx context.Context, appVersion, userAgent, username, password, proxyURL string, captchaAutoOpen bool) (*proton.Manager, *proton.Client, proton.Auth, error) {
	baseTransport, err := proxyTransport(proxyURL)
	if err != nil {
		return nil, nil, proton.Auth{}, err
	}
	// newManager builds a Proton manager carrying the given round-tripper (the
	// proxy, optionally wrapped with the human-verification headers). A nil
	// round-tripper keeps go-proton-api's default transport.
	newManager := func(rt http.RoundTripper) *proton.Manager {
		opts := []proton.Option{
			proton.WithAppVersion(appVersion),
			proton.WithUserAgent(userAgent),
		}
		if rt != nil {
			opts = append(opts, proton.WithTransport(rt))
		}
		return proton.New(opts...)
	}

	firstTransport := baseTransport
	if proxyURL == "" {
		firstTransport = nil // no proxy: keep the library default transport
	}
	manager := newManager(firstTransport)

	client, auth, err := manager.NewClientWithLogin(ctx, username, []byte(password))
	if err == nil {
		return manager, client, auth, nil
	}
	manager.Close()

	hv, ok := asHumanVerification(err)
	if !ok {
		return nil, nil, proton.Auth{}, err
	}
	if !hv.supportsCaptcha() {
		return nil, nil, proton.Auth{}, fmt.Errorf(
			"human verification required, but CAPTCHA is not offered (available methods: %s): %w",
			strings.Join(hv.Methods, ", "), err,
		)
	}

	// Bind the challenge to Proton's real HumanVerificationToken and solve it
	// through the same proxy the login used.
	captchaToken, err := solveCaptcha(ctx, legacyTarget(hv.Token), username, captchaAutoOpen, proxyURL)
	if err != nil {
		return nil, nil, proton.Auth{}, err
	}

	manager = newManager(newHVTransport(baseTransport, captchaToken, "captcha"))
	client, auth, err = manager.NewClientWithLogin(ctx, username, []byte(password))
	if err != nil {
		manager.Close()
		return nil, nil, proton.Auth{}, err
	}

	return manager, client, auth, nil
}

func authenticate(appVersion, userAgent, proxyURL string, captchaAutoOpen bool, creds credentials) AuthResult {
	reader := bufio.NewReader(os.Stdin)

	password := creds.password
	if creds.username == "" || password == "" {
		// Interactive path: prompt for username and (hidden) password.
		fmt.Fprint(os.Stderr, "Proton username (email): ")
		username, err := reader.ReadString('\n')
		if err != nil {
			return AuthResult{Error: "Failed to read username", ErrorCode: 1000}
		}
		creds.username = strings.TrimSpace(username)

		fmt.Fprint(os.Stderr, "Password: ")
		passwordBytes, err := term.ReadPassword(int(syscall.Stdin))
		fmt.Fprintln(os.Stderr) // newline after password
		if err != nil {
			return AuthResult{Error: "Failed to read password", ErrorCode: 1000}
		}
		password = string(passwordBytes)
	}
	username := creds.username

	// Perform SRP authentication, letting the user solve a CAPTCHA if Proton asks for one
	ctx := context.Background()
	manager, client, auth, err := login(ctx, appVersion, userAgent, username, password, proxyURL, captchaAutoOpen)
	if err != nil {
		return AuthResult{
			Error:     friendlyAuthError(err),
			ErrorCode: 1001,
		}
	}
	defer manager.Close()
	defer client.Close()

	// Check if 2FA is required
	if auth.TwoFA.Enabled != 0 {
		totp := creds.totpCode
		if totp == "" && creds.totpSecret != "" {
			totp = generateTOTP(creds.totpSecret, time.Now())
		}
		if totp == "" {
			// Interactive fallback only when stdin is usable; in non-interactive
			// mode (-username/-password or env) fail with an actionable error.
			if creds.username != "" && creds.password != "" {
				return AuthResult{Error: "2FA required: supply -totp <code> or -totp-secret <base32>", ErrorCode: 1002}
			}
			fmt.Fprint(os.Stderr, "2FA TOTP code: ")
			line, err := reader.ReadString('\n')
			if err != nil {
				return AuthResult{Error: "Failed to read TOTP", ErrorCode: 1002}
			}
			totp = strings.TrimSpace(line)
		}

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
