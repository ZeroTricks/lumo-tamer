/**
 * Node.js-adapted Redux slices for lumo-tamer
 *
 * Only includes core slices needed for storage/sync.
 * UI slices (ghostChat, contextFilters, personalization, featureFlags) are omitted.
 */

import attachmentsReducer from './core/attachments';
import conversationsReducer from './core/conversations';
import credentialsReducer from './core/credentials';
import idMapReducer from './core/idmap';
import messagesReducer from './core/messages';
import spacesReducer from './core/spaces';
import initializationReducer from './meta/initialization';

// Type for attachment loading state
type AttachmentLoadingStateMap = Record<string, unknown>;

// Stub type for user state (the actual user data comes from @proton/shared in browser)
type UserState = {
    value?: {
        ID?: string;
        Name?: string;
        Email?: string;
    };
};

export const lumoReducers = {
    spaces: spacesReducer,
    conversations: conversationsReducer,
    messages: messagesReducer,
    attachments: attachmentsReducer,
    credentials: credentialsReducer,
    idmap: idMapReducer,
    initialization: initializationReducer,
    // Stub reducers for slices referenced by selectors but not needed for Node.js
    attachmentLoadingState: (_state: AttachmentLoadingStateMap = {}) => _state,
    user: (_state: UserState = { value: undefined }) => _state,
    ghostChat: (_state = { isGhostChatMode: false }) => _state,
    personalization: (_state = {}) => _state,
    contextFilters: (_state = { filters: [] }) => _state,
};
