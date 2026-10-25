/**
 * Session / project / file approval for CLI local actions.
 *
 * Reads stay automatic. Create/edit prompts can be widened so multi-file
 * work does not ask once per file.
 */

import { isAbsolute, relative, resolve } from 'path';

export type ActionKind = 'create' | 'edit' | 'execute';

export class ApprovalPolicy {
  /** Allow every create/edit for the rest of this CLI process. */
  sessionFileWrites = false;
  /** Allow create/edit under the project root for the rest of this process. */
  sessionProjectWrites = false;
  /** Resolved file paths allowed for the rest of this process. */
  approvedFiles = new Set<string>();
  /** Apply remaining confirmed actions in the current Lumo turn. */
  approveRestOfTurn = false;
  projectRoot: string;

  constructor(projectRoot = process.cwd()) {
    this.projectRoot = resolve(projectRoot);
  }

  resetTurn(): void {
    this.approveRestOfTurn = false;
  }

  remember(result: 'file' | 'project' | 'session' | 'all_turn', filePath?: string): void {
    if (result === 'all_turn') this.approveRestOfTurn = true;
    if (result === 'session') this.sessionFileWrites = true;
    if (result === 'project') this.sessionProjectWrites = true;
    if (result === 'file' && filePath) {
      this.approvedFiles.add(this.resolvePath(filePath));
    }
  }

  autoApproveReason(kind: ActionKind, filePath?: string): string | undefined {
    if (this.approveRestOfTurn) return 'remaining this turn';
    if (kind === 'execute') return undefined;
    if (this.sessionFileWrites) return 'session';
    if (filePath && this.approvedFiles.has(this.resolvePath(filePath))) return 'file';
    if (this.sessionProjectWrites && filePath && this.isInsideProject(filePath)) return 'project';
    return undefined;
  }

  resolvePath(filePath: string): string {
    return resolve(this.projectRoot, filePath);
  }

  isInsideProject(filePath: string): boolean {
    const resolved = this.resolvePath(filePath);
    const rel = relative(this.projectRoot, resolved);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  }
}

/** One policy per CLI process. */
export const approvalPolicy = new ApprovalPolicy();
