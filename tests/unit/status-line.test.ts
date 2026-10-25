import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'stream';
import { StatusLine } from '../../src/app/status-line.js';

function mockStream() {
  let output = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      output += chunk.toString();
      cb();
    },
  }) as NodeJS.WriteStream;
  return {
    stream,
    text: () => output,
  };
}

describe('StatusLine', () => {
  let status: StatusLine | undefined;

  afterEach(() => {
    status?.stop();
  });

  it('writes a waiting message and clears it on stop', () => {
    const mock = mockStream();
    status = new StatusLine(mock.stream);
    status.start('Waiting for Lumo');
    expect(mock.text()).toContain('Waiting for Lumo');
    expect(mock.text()).toContain('(0s)');
    status.update('Lumo is thinking');
    expect(mock.text()).toContain('Lumo is thinking');
    status.stop();
    expect(mock.text()).toContain('\x1b[K');
  });
});
