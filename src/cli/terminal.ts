/** Print a message to the user's terminal (bypasses console shim). */
export function printToChat(text: string): void {
  process.stdout.write(text);
}

export const BUSY_INDICATOR = '...';

export function clearBusyIndicator(): void {
  // Backspace over "..."
  process.stdout.write('\b\b\b   \b\b\b');
}
