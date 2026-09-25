// 홈: 질문 입력칸 + 내 대화 목록 (예전 StartChatPage.vue).
// 모양은 AXPI의 추진 계획서 목록 화면: 패널 머리 아래에 행 목록.
// 예시 질문은 입력칸을 누르면 입력칸 아래에 펼쳐진다 (Composer의 suggestions).
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Composer } from '@/features/chat/Composer';
import { useChatStore } from '@/stores/chatStore';
import { formatKoreanDateTime } from '@/utils/formatters';
import { EXAMPLE_QUESTIONS } from './examples';
import './home.css';

export function HomePage() {
    const navigate = useNavigate();
    const sessions = useChatStore((s) => s.sessions);
    const loaded = useChatStore((s) => s.loaded);

    useEffect(() => {
        if (!useChatStore.getState().loaded) useChatStore.getState().fetchSessions().catch(() => {});
    }, []);

    // 새 대화로 질문을 보내고 대화 화면으로 간다. 답변은 대화 화면에서 이어서 보인다
    const ask = (question: string) => {
        const store = useChatStore.getState();
        if (!store.waitingForResponse) {
            store.newChat();
            store.sendMessage(question);
        }
        navigate('/chat');
    };

    const open = (sessionId: string) => {
        const store = useChatStore.getState();
        // 답변을 기다리는 중이면 그 대화를 그대로 보여 준다 (옮기면 질문이 취소된다)
        if (!store.waitingForResponse && store.currentSession?.sessionId !== sessionId)
            store.selectSession(sessionId).catch(() => {});
        navigate('/chat');
    };

    return (
        <section className="plan-panel home-panel" aria-label="홈">
            <div className="plan-panel-header">
                <p className="plan-panel-eyebrow">대화 목록</p>
            </div>

            <Composer
                variant="home"
                placeholder="AWS 클라우드 운영에 관한 질문을 물어보세요!"
                onSend={ask}
                suggestions={EXAMPLE_QUESTIONS}
            />

            <div className="plan-table home-sessions">
                <div className="plan-table-header">
                    <span className="plan-table-col-project">대화</span>
                    <span className="home-col-date">마지막 대화</span>
                    <span className="plan-table-col-action" />
                </div>

                {!loaded ? (
                    <div className="plan-panel-loading home-sessions-state">
                        <div>
                            <div className="plan-inline-spinner" />
                            <p>대화 목록을 불러오는 중...</p>
                        </div>
                    </div>
                ) : sessions.length === 0 ? (
                    <div className="plan-panel-empty home-sessions-state">
                        <p>아직 대화가 없습니다. 위 입력칸에 질문해 보세요.</p>
                    </div>
                ) : (
                    <ul className="plan-table-body home-session-list">
                        {sessions.map((session) => (
                            <li
                                key={session.sessionId}
                                className="plan-table-row is-clickable"
                                role="button"
                                tabIndex={0}
                                aria-label={`${session.title} 대화 열기`}
                                onClick={() => open(session.sessionId)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        open(session.sessionId);
                                    }
                                }}
                            >
                                <div className="plan-row-project">
                                    <span className="plan-row-name home-session-title">{session.title}</span>
                                </div>
                                <div className="plan-row-date home-col-date">
                                    {formatKoreanDateTime(session.updatedAt)}
                                </div>
                                <div className="plan-row-action home-row-arrow" aria-hidden="true">
                                    ›
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
}
