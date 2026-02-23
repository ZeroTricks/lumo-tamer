/**
 * Attachment loading state stub for Node.js
 *
 * The browser version tracks loading states for UI.
 * For lumo-tamer, we stub this with a minimal implementation.
 */

import { createAction, createReducer } from '@reduxjs/toolkit';

export type AttachmentLoadingStateMap = Record<string, unknown>;

const initialState: AttachmentLoadingStateMap = {};

// Stub actions (no-op for Node.js)
// Accept both `id` and `attachmentId` for compatibility with saga calls
export const setAttachmentLoading = createAction<string>('attachmentLoadingState/setLoading');
export const setAttachmentError = createAction<{ id: string; error: string }>('attachmentLoadingState/setError');
export const clearAttachmentLoading = createAction<string>('attachmentLoadingState/clearLoading');

export const attachmentLoadingStateReducer = createReducer(initialState, (builder) => {
    builder
        .addCase(setAttachmentLoading, (state) => state)
        .addCase(setAttachmentError, (state) => state)
        .addCase(clearAttachmentLoading, (state) => state);
});
