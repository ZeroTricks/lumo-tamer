/**
 * Redux Sagas Shim
 *
 * Replaces: applications/lumo/src/app/redux/sagas/index.ts (lines 184-212)
 *
 * Provides only the error classes needed by remote/api.ts.
 * Original file is 630 lines with full Redux saga implementations.
 *
 * Exports (shim line → original line):
 * - ClientError: 8-17 → 184-193
 * - ConflictClientError: 19-28 → 195-204
 * - isClientError(): 30-32 → 206-208
 * - isConflictClientError(): 34-36 → 210-212
 */

export class ClientError extends Error {
    constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, ClientError.prototype);
        this.name = 'ClientError';
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ClientError);
        }
    }
}

export class ConflictClientError extends ClientError {
    constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, ConflictClientError.prototype);
        this.name = 'ConflictClientError';
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ConflictClientError);
        }
    }
}

export function isClientError(err: unknown): err is ClientError {
    return err instanceof ClientError;
}

export function isConflictClientError(err: unknown): err is ConflictClientError {
    return err instanceof ConflictClientError;
}
