/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
export interface RagStore {
    name: string;
    displayName: string;
}

export interface CustomMetadata {
  key?: string;
  stringValue?: string;
  stringListValue?: string[];
  numericValue?: number;
}

export interface Document {
    name: string;
    displayName: string;
    customMetadata?: CustomMetadata[];
}

export interface GroundingChunk {
    retrievedContext?: {
        text?: string;
    };
}

export interface QueryResult {
    text: string;
    groundingChunks: GroundingChunk[];
}

export enum AppStatus {
    Initializing,
    Welcome, // No longer used directly, but kept for clarity in the enum
    Uploading,
    Chatting,
    Error,
}

export interface ChatMessage {
    role: 'user' | 'model';
    parts: { text: string }[];
    groundingChunks?: GroundingChunk[];
}

// --- Types for Post-Message Communication ---

export interface InitChatPayloadFile {
    fileName: string;
    mimeType?: string; // Required if base64Data is present
    url?: string; // URL to fetch the file from
    base64Data?: string; // Base64 encoded file content
}

export interface InitChatPayload {
    files: InitChatPayloadFile[];
    chatDisplayName?: string;
    apiKey?: string; // Optional: to override process.env.API_KEY
}

export interface SendMessagePayload {
    message: string;
}

export interface ParentMessage {
    type: 'initChat' | 'sendMessage' | 'resetChat';
    payload: InitChatPayload | SendMessagePayload | {};
}

export interface ChatReadyPayload {
    documentName: string;
}

export interface ChatResponsePayload {
    text: string;
    groundingChunks: GroundingChunk[];
}

export interface ChatErrorPayload {
    message: string;
}

export interface ChatEndedPayload {
    message: string;
}

export interface ChildMessage {
    type: 'chatReady' | 'chatResponse' | 'chatError' | 'chatEnded';
    payload: ChatReadyPayload | ChatResponsePayload | ChatErrorPayload | ChatEndedPayload;
}
