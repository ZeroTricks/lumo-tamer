/** Print a message to the user's terminal (bypasses console shim). */
export function print(text: string, newline = true): void {
  process.stdout.write(text + (newline ? '\n' : ''));
}

export const BUSY_INDICATOR = '...';

export function clearBusyIndicator(): void {
  // Backspace over "..."
  process.stdout.write('\b\b\b   \b\b\b');
}

export function printHelp(): void {
  print(`
lumo-tamer - Use Proton Lumo on the command line

Usage:
  tamer                      Interactive chat mode
  tamer "your prompt"        One-shot query
  tamer auth [method]        Authenticate to Proton
  tamer auth status          Show authentication status
  tamer server               Start API server
  tamer --help               Show this help

Commands:
  auth                       Authenticate to Proton (login, browser, or rclone)
  server                     Start OpenAI-compatible API server

Options:
  -h, --help    Show help

`);
}

export function printAuthHelp(): void {
  print(`
tamer auth - Authenticate to Proton

Usage:
  tamer auth                 Interactive method selection
  tamer auth <method>        Use specific method (login, browser, rclone)
  tamer auth status          Show current authentication status
  tamer auth --help          Show this help

Methods:
  login                      Enter Proton credentials
  browser                    Extract tokens from logged-in browser session
  rclone                     Paste rclone config section

`);
}

export function printServerHelp(): void {
  print(`
tamer server - Start OpenAI-compatible API server

Usage:
  tamer server               Start the API server
  tamer server --help        Show this help

The server listens on the port configured in config.yaml (default: 3003).
`);
}

