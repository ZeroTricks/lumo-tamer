/**
 * Node.js-adapted Redux selectors for lumo-tamer
 *
 * Removes dependency on react-redux Selector type and UI-related selectors.
 */

import type { LocalId, RemoteId, ResourceType } from '../remote/types';
import type { Attachment, AttachmentId, Conversation, Message, Space } from '../types';
import { type ConversationId, type MessageId, Role, type SpaceId } from '../types';
import { listify, mapIds, setify } from '../util/collections';
import { sortByDate } from '../util/date';
import { objectFilterV } from '../util/objects';
import { EMPTY_ATTACHMENT_MAP } from './slices/core/attachments';
import { EMPTY_CONVERSATION_MAP } from './slices/core/conversations';
import { EMPTY_MESSAGE_MAP } from './slices/core/messages';
import type { LumoState } from './store';

export type LumoSelector<T> = (state: LumoState) => T;

/*
 * Helper that wraps any selector to accept optional input, returning
 * a predefined fallback value if input is null/undefined.
 */
export const makeOptional =
    <TArg, TResult>(selector: (arg: TArg) => LumoSelector<TResult>, fallback: TResult) =>
    (arg: TArg | null | undefined): LumoSelector<TResult> =>
    (state: LumoState) =>
        arg !== null && arg !== undefined ? selector(arg)(state) : fallback;

/*
 * Selectors specific to Lumo.
 */

export const selectMessages = (state: LumoState) => state.messages;
export const selectMasterKey = (state: LumoState) => state.credentials.masterKey;
export const selectConversations = (state: LumoState) => state.conversations;
export const selectAttachments = (state: LumoState) => state.attachments;

export const selectMessageById =
    (id: MessageId): LumoSelector<Message | undefined> =>
    (state: LumoState): Message | undefined =>
        state.messages[id];

export const selectConversationById =
    (id: ConversationId): LumoSelector<Conversation | undefined> =>
    (state: LumoState) =>
        state.conversations[id];

export const selectSpaceById =
    (id: SpaceId): LumoSelector<Space | undefined> =>
    (state: LumoState) =>
        state.spaces[id];

export const selectAttachmentById =
    (id: SpaceId): LumoSelector<Attachment | undefined> =>
    (state: LumoState) =>
        state.attachments[id];

export const selectAttachmentByIdOptional = makeOptional(selectAttachmentById, undefined);

export const selectMessagesByConversationId =
    (conversationId: ConversationId | null | undefined) => (state: LumoState) =>
        objectFilterV(state.messages, (m: Message) => m.conversationId === conversationId, EMPTY_MESSAGE_MAP);

export const selectConversationsBySpaceId = (spaceId: SpaceId | null | undefined) => (state: LumoState) =>
    objectFilterV(state.conversations, (c: Conversation) => c.spaceId === spaceId, EMPTY_CONVERSATION_MAP);

export const selectMessagesBySpaceId = (spaceId: SpaceId | null | undefined) => (state: LumoState) => {
    const conversationIds = setify(mapIds(selectConversationsBySpaceId(spaceId)(state)));
    return objectFilterV(state.messages, (m: Message) => conversationIds.has(m.conversationId), EMPTY_MESSAGE_MAP);
};

export const selectAttachmentsBySpaceId = (spaceId: SpaceId | null | undefined) => (state: LumoState) =>
    objectFilterV(state.attachments, (c: Attachment) => c.spaceId === spaceId, EMPTY_ATTACHMENT_MAP);

export const selectAttachmentLoadingState = (attachmentId: AttachmentId) => (state: LumoState) =>
    state.attachmentLoadingState[attachmentId];

export const selectAttachmentLoadingStateOptional = makeOptional(selectAttachmentLoadingState, undefined);

export const selectSpaceByIdOptional = makeOptional(selectSpaceById, undefined);

export const selectAllUserMessages = (state: LumoState) =>
    objectFilterV(state.messages, (m: Message) => m.role === Role.User);

export const selectFavoritedConversations = (state: LumoState) =>
    objectFilterV(state.conversations, (c: Conversation) => !!c.starred);

export const selectSpaceByConversationId =
    (conversationId: ConversationId) =>
    (state: LumoState): Space | undefined => {
        const conversation = selectConversationById(conversationId)(state);
        return conversation && state.spaces[conversation.spaceId];
    };

export const selectProvisionalAttachments = (state: LumoState) =>
    listify(state.attachments)
        .filter((a: Attachment) => !a.spaceId)
        .slice()
        .sort(sortByDate('asc', 'uploadedAt'));

export const selectLocalIdFromRemote =
    (type: ResourceType, remoteId: RemoteId) =>
    (state: LumoState): LocalId | undefined =>
        state.idmap.remote2local[type][remoteId];

export const selectRemoteIdFromLocal =
    (type: ResourceType, localId: LocalId) =>
    (state: LumoState): RemoteId | undefined =>
        state.idmap.local2remote[type][localId];
