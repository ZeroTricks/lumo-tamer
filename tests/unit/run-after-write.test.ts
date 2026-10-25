import { describe, it, expect } from 'vitest';
import { inferRunCommand } from '../../src/cli/local-actions/run-after-write.js';
import { isDangerousCommand } from '../../src/cli/local-actions/code-executor.js';

describe('inferRunCommand', () => {
  it('opens html and runs python', () => {
    expect(inferRunCommand(['index.html'])).toMatch(/index.html/);
    expect(inferRunCommand(['main.py'])).toBe('python3 main.py');
    expect(inferRunCommand(['app.js'])).toBe('node app.js');
    expect(inferRunCommand([])).toBeUndefined();
  });
});

describe('isDangerousCommand', () => {
  it('flags destructive or install commands', () => {
    expect(isDangerousCommand('rm -rf /')).toBe(true);
    expect(isDangerousCommand('npm install evil')).toBe(true);
    expect(isDangerousCommand('python3 main.py')).toBe(false);
  });
});
