// src/types/chat.ts
export interface ChatMessageType {
    id: string;
    sender: 'user' | 'assistant';
    text: string;
    displayText?: string;
    timestamp: string;
    isTyping?: boolean;
    animationState?: 'appear' | 'typing' | 'complete';
    query_string?: string;
    query_result?: any[];
    elapsed_time?: string | number;
    inference?: any;
    progress?: LiveProgress; // 답을 기다리는 동안의 진행 상황 (기다리는 메시지에만 있다)
}

// GET /llm1/progress/{requestId}의 응답 (services/llm/llm_progress.py)
export interface LiveProgress {
    phase: 'thinking' | 'tool' | 'done' | 'error';
    steps: unknown[]; // 화면에 그릴 때 utils/toolTrace.ts의 fromProgressSteps로 바꾼다
}

export interface ChatSession {
    sessionId: string;
    userId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messages: ChatMessageType[];
}

export interface ChatHistoryState {
    loading: boolean;
    error: string | null;
    sessions: ChatSession[];
    currentSession: ChatSession | null;
    waitingForResponse: boolean;
}

export interface BotResponse {
    text: string;
    query_string?: string;
    query_result?: any[];
    elapsed_time?: string | number;
    inference?: any;
}
