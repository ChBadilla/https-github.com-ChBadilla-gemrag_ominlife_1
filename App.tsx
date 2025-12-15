/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AppStatus, ChatMessage, ParentMessage, ChildMessage, InitChatPayloadFile, InitChatPayload, SendMessagePayload } from './types';
import * as geminiService from './services/geminiService';
import Spinner from './components/Spinner';
import ProgressBar from './components/ProgressBar';
import ChatInterface from './components/ChatInterface';

// DO: Define the AIStudio interface to resolve a type conflict where `window.aistudio` was being redeclared with an anonymous type.
// FIX: Moved the AIStudio interface definition inside the `declare global` block to resolve a TypeScript type conflict.
declare global {
    interface AIStudio {
        openSelectKey: () => Promise<void>;
        hasSelectedApiKey: () => Promise<boolean>;
    }
    interface Window {
        aistudio?: AIStudio;
    }
}

const App: React.FC = () => {
    const [status, setStatus] = useState<AppStatus>(AppStatus.Initializing);
    const [error, setError] = useState<string | null>(null);
    const [uploadProgress, setUploadProgress] = useState<{ current: number, total: number, message?: string, fileName?: string } | null>(null);
    const [activeRagStoreName, setActiveRagStoreName] = useState<string | null>(null);
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
    const [isQueryLoading, setIsQueryLoading] = useState(false);
    const [exampleQuestions, setExampleQuestions] = useState<string[]>([]);
    const [documentName, setDocumentName] = useState<string>('');
    const ragStoreNameRef = useRef(activeRagStoreName);

    useEffect(() => {
        ragStoreNameRef.current = activeRagStoreName;
    }, [activeRagStoreName]);

    // Send messages to the parent window
    const postMessageToParent = useCallback((type: ChildMessage['type'], payload: ChildMessage['payload']) => {
        if (window.parent) {
            window.parent.postMessage({ type, payload }, '*'); // Use '*' for targetOrigin for embeddable iframes
        }
    }, []);

    const handleError = (message: string, err: any) => {
        console.error(message, err);
        const errorMessage = `${message}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`;
        setError(errorMessage);
        setStatus(AppStatus.Error);
        postMessageToParent('chatError', { message: errorMessage });
    };

    const clearError = () => {
        setError(null);
        // We don't return to Welcome, but to Initializing (waiting for new initChat)
        setStatus(AppStatus.Initializing);
    }

    // Effect for handling postMessage events from the parent window
    useEffect(() => {
        const handleMessage = async (event: MessageEvent<ParentMessage>) => {
            // Ensure the message is from a trusted source if possible, or validate its structure
            if (event.source !== window.parent || !event.data || !event.data.type) {
                return;
            }

            const { type, payload } = event.data;

            switch (type) {
                case 'initChat':
                    // Fix: Explicitly assert the type of payload for 'initChat'
                    const initChatPayload = payload as InitChatPayload;
                    if (status !== AppStatus.Initializing && status !== AppStatus.Error && status !== AppStatus.Chatting) {
                         // Only allow initChat if not currently uploading or already chatting
                        console.warn('Ignoring initChat: App is not in an initial or error state.');
                        return;
                    }
                    await handleInitChat(initChatPayload.files, initChatPayload.chatDisplayName);
                    break;
                case 'sendMessage':
                    // Fix: Explicitly assert the type of payload for 'sendMessage'
                    const sendMessagePayload = payload as SendMessagePayload;
                    if (status === AppStatus.Chatting) {
                        await handleSendMessage(sendMessagePayload.message);
                    } else {
                        console.warn('Cannot send message: Chat is not active.');
                        postMessageToParent('chatError', { message: 'Chat is not active to send message.' });
                    }
                    break;
                case 'resetChat':
                    await handleResetChat();
                    break;
                default:
                    console.warn(`Unknown message type received: ${type}`);
                    break;
            }
        };

        window.addEventListener('message', handleMessage);

        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, [status, postMessageToParent]); // Include postMessageToParent in dependencies

    // Cleanup RAG store on component unmount or tab close
    useEffect(() => {
        const handleUnload = () => {
            if (ragStoreNameRef.current) {
                geminiService.deleteRagStore(ragStoreNameRef.current)
                    .catch(err => console.error("Error deleting RAG store on unload:", err));
            }
        };

        window.addEventListener('beforeunload', handleUnload);

        return () => {
            window.removeEventListener('beforeunload', handleUnload);
        };
    }, []);

    // Helper to fetch files from URL or decode base64
    const getFileFromPayload = async (filePayload: InitChatPayloadFile): Promise<File> => {
        if (filePayload.url) {
            const response = await fetch(filePayload.url);
            if (!response.ok) {
                throw new Error(`Failed to fetch file from URL: ${filePayload.url} - ${response.statusText}`);
            }
            const blob = await response.blob();
            return new File([blob], filePayload.fileName || 'unknown_file', { type: filePayload.mimeType || blob.type });
        } else if (filePayload.base64Data && filePayload.mimeType) {
            const byteCharacters = atob(filePayload.base64Data);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            return new File([byteArray], filePayload.fileName || 'unknown_file', { type: filePayload.mimeType });
        } else {
            throw new Error('Invalid file payload: must provide url or base64Data with mimeType.');
        }
    };

    const handleInitChat = async (filePayloads: InitChatPayloadFile[], chatDisplayName?: string) => {
        if (filePayloads.length === 0) {
            handleError("No files provided for chat initialization.", null);
            return;
        }
        
        // Always re-initialize geminiService to ensure the API key is current (though we assume process.env.API_KEY is stable)
        try {
            geminiService.initialize();
        } catch (err) {
            handleError("Initialization failed.", err);
            return;
        }
        
        setStatus(AppStatus.Uploading);
        setError(null); // Clear previous errors
        const totalSteps = filePayloads.length + 2; // Create store, upload each file, generate questions

        setUploadProgress({ current: 0, total: totalSteps, message: "Creating document index..." });

        let ragStoreName: string | null = null;
        try {
            const storeName = `chat-session-${Date.now()}`;
            ragStoreName = await geminiService.createRagStore(storeName);
            setActiveRagStoreName(ragStoreName);
            
            setUploadProgress(prev => ({ ...(prev!), current: 1, message: "Generating embeddings..." }));

            const filesToUpload: File[] = [];
            for (let i = 0; i < filePayloads.length; i++) {
                setUploadProgress(prev => ({ 
                    ...(prev!),
                    current: i + 1,
                    message: "Fetching/Processing files...",
                    fileName: `(${i + 1}/${filePayloads.length}) ${filePayloads[i].fileName || 'file'}`
                }));
                const file = await getFileFromPayload(filePayloads[i]);
                filesToUpload.push(file);
                await geminiService.uploadToRagStore(ragStoreName, file);
            }
            
            setUploadProgress(prev => ({ ...(prev!), current: filePayloads.length + 1, message: "Generating suggestions...", fileName: "" }));
            const questions = await geminiService.generateExampleQuestions(ragStoreName);
            setExampleQuestions(questions);

            setUploadProgress({ current: totalSteps, total: totalSteps, message: "All set!", fileName: "" });
            
            await new Promise(resolve => setTimeout(resolve, 500)); // Short delay to show "All set!"

            let docName = '';
            if (chatDisplayName) {
                docName = chatDisplayName;
            } else if (filesToUpload.length === 1) {
                docName = filesToUpload[0].name;
            } else if (filesToUpload.length === 2) {
                docName = `${filesToUpload[0].name} & ${filesToUpload[1].name}`;
            } else {
                docName = `${filesToUpload.length} documents`;
            }
            setDocumentName(docName);

            setChatHistory([]);
            setStatus(AppStatus.Chatting);
            postMessageToParent('chatReady', { documentName: docName });
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
            if (errorMessage.includes('api key not valid') || errorMessage.includes('requested entity was not found')) {
                handleError("The API key is invalid or not found. Please ensure a valid API Key is configured.", err);
            } else {
                handleError("Failed to start chat session", err);
            }
            // Attempt to clean up if RAG store was partially created
            if (ragStoreName) {
                geminiService.deleteRagStore(ragStoreName).catch(deleteErr => console.error("Error cleaning up RAG store after init error:", deleteErr));
            }
        } finally {
            setUploadProgress(null);
        }
    };

    const handleResetChat = async () => {
        if (activeRagStoreName) {
            setIsQueryLoading(true); // Indicate cleanup is happening
            try {
                await geminiService.deleteRagStore(activeRagStoreName);
                setActiveRagStoreName(null);
                setChatHistory([]);
                setExampleQuestions([]);
                setDocumentName('');
                setStatus(AppStatus.Initializing); // Back to waiting for new initChat
                postMessageToParent('chatEnded', { message: 'Chat session reset.' });
            } catch (err) {
                handleError("Failed to delete RAG store during reset.", err);
            } finally {
                setIsQueryLoading(false);
            }
        } else {
            // Already clean, just reset state
            setActiveRagStoreName(null);
            setChatHistory([]);
            setExampleQuestions([]);
            setDocumentName('');
            setStatus(AppStatus.Initializing);
            postMessageToParent('chatEnded', { message: 'Chat session reset (no active store).' });
        }
    };

    const handleSendMessage = async (message: string) => {
        if (!activeRagStoreName) {
            postMessageToParent('chatError', { message: 'No active chat session. Please initialize first.' });
            return;
        }

        const userMessage: ChatMessage = { role: 'user', parts: [{ text: message }] };
        setChatHistory(prev => [...prev, userMessage]);
        setIsQueryLoading(true);

        try {
            const result = await geminiService.fileSearch(activeRagStoreName, message);
            const modelMessage: ChatMessage = {
                role: 'model',
                parts: [{ text: result.text }],
                groundingChunks: result.groundingChunks
            };
            setChatHistory(prev => [...prev, modelMessage]);
            postMessageToParent('chatResponse', { text: result.text, groundingChunks: result.groundingChunks });
        } catch (err) {
            const errorMessage: ChatMessage = {
                role: 'model',
                parts: [{ text: "Sorry, I encountered an error. Please try again." }]
            };
            setChatHistory(prev => [...prev, errorMessage]);
            handleError("Failed to get response", err);
            postMessageToParent('chatError', { message: `Failed to get response: ${err instanceof Error ? err.message : String(err)}` });
        } finally {
            setIsQueryLoading(false);
        }
    };
    
    const renderContent = () => {
        switch(status) {
            case AppStatus.Initializing:
                return (
                    <div className="flex items-center justify-center h-screen">
                        <Spinner /> <span className="ml-4 text-xl">Waiting for initialization...</span>
                    </div>
                );
            case AppStatus.Uploading:
                let icon = null;
                if (uploadProgress?.message === "Creating document index...") {
                    icon = <img src="https://services.google.com/fh/files/misc/applet-upload.png" alt="Uploading files icon" className="h-80 w-80 rounded-lg object-cover" />;
                } else if (uploadProgress?.message === "Generating embeddings...") {
                    icon = <img src="https://services.google.com/fh/files/misc/applet-creating-embeddings_2.png" alt="Creating embeddings icon" className="h-80 w-80 rounded-lg object-cover" />;
                } else if (uploadProgress?.message === "Generating suggestions...") {
                    icon = <img src="https://services.google.com/fh/files/misc/applet-suggestions_2.png" alt="Generating suggestions icon" className="h-80 w-80 rounded-lg object-cover" />;
                } else if (uploadProgress?.message === "All set!") {
                    icon = <img src="https://services.google.com/fh/files/misc/applet-completion_2.png" alt="Completion icon" className="h-80 w-80 rounded-lg object-cover" />;
                }

                return <ProgressBar 
                    progress={uploadProgress?.current || 0} 
                    total={uploadProgress?.total || 1} 
                    message={uploadProgress?.message || "Preparing your chat..."} 
                    fileName={uploadProgress?.fileName}
                    icon={icon}
                />;
            case AppStatus.Chatting:
                return <ChatInterface 
                    documentName={documentName}
                    history={chatHistory}
                    isQueryLoading={isQueryLoading}
                    onSendMessage={handleSendMessage}
                    onNewChat={handleResetChat} // Re-purposed to handle reset from parent for now
                    exampleQuestions={exampleQuestions}
                    hideNewChatButton={true} // Hide the button in embeddable context
                />;
            case AppStatus.Error:
                 return (
                    <div className="flex flex-col items-center justify-center h-screen bg-red-900/20 text-red-300">
                        <h1 className="text-3xl font-bold mb-4">Application Error</h1>
                        <p className="max-w-md text-center mb-4">{error}</p>
                        <button onClick={clearError} className="px-4 py-2 rounded-md bg-gem-mist hover:bg-gem-mist/70 transition-colors" title="Return to waiting for initialization">
                           Try Again / Reset
                        </button>
                    </div>
                );
            default:
                 return (
                    <div className="flex items-center justify-center h-screen">
                        <Spinner /> <span className="ml-4 text-xl">Waiting for initialization...</span>
                    </div>
                );
        }
    }

    return (
        <main className="h-screen bg-gem-onyx text-gem-offwhite">
            {renderContent()}
        </main>
    );
};

export default App;