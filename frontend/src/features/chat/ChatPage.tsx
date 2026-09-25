// 대화 화면 (예전 views/EnhancedChatbotPage.vue).
// AXPI 패널 하나 안에 왼쪽 대화 목록과 오른쪽 대화를 둔다. 좁은 화면(760px 이하)에서는 목록을 버튼으로 연다.
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EXAMPLE_QUESTIONS } from '@/features/home/examples';
import { useChatStore } from '@/stores/chatStore';
import { formatKoreanDateTime } from '@/utils/formatters';
import { ChatMessage } from './ChatMessage';
import { Composer } from './Composer';
import { SessionList } from './SessionList';
import './chat.css';

const NEAR_BOTTOM = 120; // 이만큼 안쪽까지 내려와 있으면 새 글이 올 때 따라 내려간다

export function ChatPage() {
    const currentSession = useChatStore((s) => s.currentSession);
    const waiting = useChatStore((s) => s.waitingForResponse);
    const error = useChatStore((s) => s.error);
    const loading = useChatStore((s) => s.loading);
    const [isListOpen, setIsListOpen] = useState(false);
    const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
    const messagesRef = useRef<HTMLDivElement>(null);
    const stickToBottom = useRef(true);
    const messages = currentSession?.messages ?? [];

    useEffect(() => {
        if (!useChatStore.getState().loaded) useChatStore.getState().fetchSessions().catch(() => {});
    }, []);

    // 새 메시지나 타이핑으로 글이 늘면 맨 아래로. 사용자가 위로 올려 읽는 중이면 그대로 둔다
    useEffect(() => {
        const box = messagesRef.current;
        if (box && stickToBottom.current) box.scrollTop = box.scrollHeight;
    }, [messages]);

    // 다른 대화를 열면 맨 아래부터 보여 준다
    useEffect(() => {
        stickToBottom.current = true;
    }, [currentSession?.sessionId]);

    const openSession = (sessionId: string) => {
        if (sessionId === currentSession?.sessionId) {
            setIsListOpen(false);
            return;
        }
        // 답변을 기다리는 중에 옮기면 지금 질문을 취소하게 되므로 먼저 묻는다
        if (waiting) {
            setPendingSessionId(sessionId);
            return;
        }
        useChatStore.getState().selectSession(sessionId).catch(() => {});
        setIsListOpen(false);
    };

    const newChat = () => {
        useChatStore.getState().newChat();
        setIsListOpen(false);
    };

    const send = (text: string) => {
        stickToBottom.current = true;
        useChatStore.getState().sendMessage(text);
    };

    const eyebrow = waiting
        ? '답변을 만드는 중'
        : currentSession
          ? `마지막 대화: ${formatKoreanDateTime(currentSession.updatedAt)}`
          : '새 대화';

    return (
        <section className="plan-panel chat-panel" aria-label="대화">
            <div className="plan-panel-header">
                <div className="plan-panel-header-stage">
                    <div className="chat-heading">
                        <p className="plan-panel-eyebrow">{eyebrow}</p>
                        <h1 className="plan-panel-title">{currentSession?.title ?? '새 대화'}</h1>
                    </div>
                    <div className="chat-header-actions">
                        <button
                            className="plan-reload-button chat-list-toggle"
                            type="button"
                            aria-expanded={isListOpen}
                            onClick={() => setIsListOpen((v) => !v)}
                        >
                            대화 목록
                        </button>
                        <button className="plan-create-button" type="button" disabled={waiting} onClick={newChat}>
                            + 새 대화
                        </button>
                    </div>
                </div>
            </div>

            {error ? (
                <div className="plan-panel-error-inline chat-error" role="alert">
                    <p>{error}</p>
                    <button type="button" aria-label="닫기" onClick={() => useChatStore.getState().setError(null)}>
                        ×
                    </button>
                </div>
            ) : null}

            <div className="chat-body">
                <aside className={`chat-sessions${isListOpen ? ' is-open' : ''}`} aria-label="대화 목록">
                    <SessionList onSelect={openSession} />
                </aside>
                {isListOpen ? <div className="chat-sessions-backdrop" onClick={() => setIsListOpen(false)} /> : null}

                <div className="chat-conversation">
                    <div
                        className="chat-messages"
                        ref={messagesRef}
                        onScroll={(event) => {
                            const box = event.currentTarget;
                            stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
                        }}
                    >
                        {loading && messages.length === 0 ? (
                            <div className="chat-empty">
                                <div className="plan-inline-spinner" />
                            </div>
                        ) : messages.length > 0 ? (
                            messages.map((message) => <ChatMessage key={message.id} message={message} />)
                        ) : (
                            <div className="chat-empty">
                                <p className="chat-empty-title">무엇이 궁금하세요?</p>
                                <p className="chat-empty-text">질문을 입력하거나 아래 예시를 눌러 보세요.</p>
                                <div className="chat-examples">
                                    {EXAMPLE_QUESTIONS.filter((_, i) => i % 2 === 0).map(({ question }) => (
                                        <button
                                            key={question}
                                            type="button"
                                            className="chat-example"
                                            disabled={waiting}
                                            onClick={() => send(question)}
                                        >
                                            {question}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                    <Composer variant="chat" placeholder="질문을 입력하세요..." onSend={send} />
                </div>
            </div>

            {pendingSessionId ? (
                <ConfirmDialog
                    label="대화 전환 확인"
                    message="답변을 만드는 중입니다. 다른 대화로 옮기면 지금 질문은 취소됩니다."
                    confirmText="옮기기"
                    tone="primary"
                    onConfirm={() => {
                        const target = pendingSessionId;
                        setPendingSessionId(null);
                        setIsListOpen(false);
                        useChatStore.getState().cancelRequest();
                        useChatStore.getState().selectSession(target).catch(() => {});
                    }}
                    onCancel={() => setPendingSessionId(null)}
                />
            ) : null}
        </section>
    );
}
