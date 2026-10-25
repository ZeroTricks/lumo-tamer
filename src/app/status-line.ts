/**
 * One-line activity status for the CLI (waiting, thinking, reading, writing).
 * Written to stderr so it does not mix into streamed Lumo text on stdout.
 */

const FRAMES = ['|', '/', '-', '\\'];

export class StatusLine {
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private message = '';
  private visible = false;
  private stream: NodeJS.WriteStream;

  constructor(stream: NodeJS.WriteStream = process.stderr) {
    this.stream = stream;
  }

  show(message: string): void {
    if (this.visible) this.update(message);
    else this.start(message);
  }

  start(message: string): void {
    this.stop();
    this.startedAt = Date.now();
    this.message = message;
    this.visible = true;
    this.draw();
    this.timer = setInterval(() => this.draw(), 400);
  }

  update(message: string): void {
    this.message = message;
    if (this.visible) this.draw();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.visible) {
      this.stream.write('\r\x1b[K');
      this.visible = false;
    }
  }

  private draw(): void {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const frame = FRAMES[Math.floor(Date.now() / 400) % FRAMES.length];
    const waitNote = elapsed >= 4 && this.message.toLowerCase().includes('waiting')
      ? ' still working'
      : '';
    this.stream.write(`\r\x1b[K${frame} ${this.message}${waitNote} (${elapsed}s)`);
  }
}

export const cliStatus = new StatusLine();
