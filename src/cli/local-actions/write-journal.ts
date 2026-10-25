/**
 * Snapshots file contents before create/edit so /undo can restore them.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface FileSnapshot {
  path: string;
  previous: string | null;
}

export interface UndoEntry {
  files: FileSnapshot[];
  at: number;
}

export class WriteJournal {
  private entries: UndoEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 20) {
    this.maxEntries = maxEntries;
  }

  setMaxEntries(maxEntries: number): void {
    this.maxEntries = maxEntries;
  }

  record(files: FileSnapshot[]): void {
    if (files.length === 0) return;
    this.entries.push({ files, at: Date.now() });
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  peek(): UndoEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  undo(): { restored: string[]; error?: string } {
    const entry = this.entries.pop();
    if (!entry) {
      return { restored: [], error: 'Nothing to undo.' };
    }

    const restored: string[] = [];
    try {
      for (const file of entry.files) {
        if (file.previous === null) {
          // Created file: leave it. Caller may unlink; keep restore simple and rewrite empty skip.
          continue;
        }
        const dir = dirname(file.path);
        if (dir && dir !== '.') {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(file.path, file.previous, 'utf8');
        restored.push(file.path);
      }
      const created = entry.files.filter((file) => file.previous === null).map((file) => file.path);
      return {
        restored,
        error: created.length > 0
          ? `Restored ${restored.length} file(s). New files left in place: ${created.join(', ')}`
          : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { restored, error: message };
    }
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}

export const writeJournal = new WriteJournal();
