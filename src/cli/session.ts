/**
 * Persist the last CLI session for this working directory.
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Turn } from '../lumo-client/types.js';

export interface CliSessionState {
  cwd: string;
  conversationId: string;
  lastFiles: string[];
  lastError?: string;
  title?: string;
  turns: Array<{ role: string; content: string }>;
  savedAt: string;
}

function sessionDir(): string {
  return join(homedir(), '.lumo-tamer', 'cli-sessions');
}

function sessionPath(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return join(sessionDir(), `${hash}.json`);
}

function compactTurns(turns: Turn[]): CliSessionState['turns'] {
  return turns.slice(-12).map((turn) => ({
    role: turn.role,
    content: (turn.content ?? '').slice(0, 4000),
  }));
}

export function loadCliSession(cwd: string): CliSessionState | undefined {
  try {
    const raw = readFileSync(sessionPath(cwd), 'utf8');
    const parsed = JSON.parse(raw) as CliSessionState;
    if (parsed.cwd !== cwd) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveCliSession(state: Omit<CliSessionState, 'savedAt' | 'turns'> & { turns: Turn[] }): void {
  mkdirSync(sessionDir(), { recursive: true });
  const payload: CliSessionState = {
    cwd: state.cwd,
    conversationId: state.conversationId,
    lastFiles: state.lastFiles,
    lastError: state.lastError,
    title: state.title,
    turns: compactTurns(state.turns),
    savedAt: new Date().toISOString(),
  };
  writeFileSync(sessionPath(state.cwd), JSON.stringify(payload, null, 2), 'utf8');
}
