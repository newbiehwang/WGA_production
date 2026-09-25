// 홈: 질문 입력 + 자주 묻는 질문 (예전 StartChatPage.vue).
// 모양은 AXPI의 추진 계획서 목록 화면: 패널 머리(작은 제목·큰 제목·설명) 아래에 행 목록
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Composer } from '@/features/chat/Composer';
import { useChatStore } from '@/stores/chatStore';
import { EXAMPLE_QUESTIONS } from './examples';
import './home.css';

export function HomePage() {
    const navigate = useNavigate();
    const sessionCount = useChatStore((s) => s.sessions.length);
    const loaded = useChatStore((s) => s.loaded);

    // 지난 대화 수를 보여 주려고 목록을 받아 둔다 (대화 화면으로 가면 다시 받지 않는다)
    useEffect(() => {
        if (!useChatStore.getState().loaded) useChatStore.getState().fetchSessions().catch(() => {});
    }, []);

    // 새 대화로 질문을 보내고 대화 화면으로 간다. 답변은 대화 화면에서 이어서 보인다
    const ask = (question: string) => {
        const store = useChatStore.getState();
        if (store.waitingForResponse) {
            navigate('/chat');
            return;
        }
        store.newChat();
        store.sendMessage(question);
        navigate('/chat');
    };

    return (
        <section className="plan-panel home-panel" aria-label="질문하기">
            <div className="plan-panel-header">
                <div className="plan-panel-header-stage">
                    <div>
                        <p className="plan-panel-eyebrow">Cloud Native MCP AIOps</p>
                        <h1 className="plan-panel-title">무엇이 궁금하세요?</h1>
                        <p className="plan-panel-subtitle">
                            AWS 클라우드 운영 정보와 매뉴얼을 MCP 도구로 찾아 답합니다.
                        </p>
                    </div>
                    {loaded && sessionCount > 0 ? (
                        <button className="plan-reload-button" type="button" onClick={() => navigate('/chat')}>
                            지난 대화 {sessionCount}개
                        </button>
                    ) : null}
                </div>
            </div>

            <Composer
                variant="home"
                placeholder="AWS 클라우드 운영에 관한 질문을 물어보세요!"
                onSend={ask}
            />

            <div className="plan-table home-examples">
                <div className="plan-table-header">
                    <span className="home-col-category">분류</span>
                    <span className="plan-table-col-project">자주 묻는 질문</span>
                    <span className="plan-table-col-action" />
                </div>
                <ul className="plan-table-body home-example-list">
                    {EXAMPLE_QUESTIONS.map(({ category, question }) => (
                        <li
                            key={question}
                            className="plan-table-row is-clickable"
                            role="button"
                            tabIndex={0}
                            aria-label={`${question} 질문하기`}
                            onClick={() => ask(question)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    ask(question);
                                }
                            }}
                        >
                            <div className="home-col-category">
                                <span className="plan-status-badge plan-status-active">{category}</span>
                            </div>
                            <div className="plan-row-project">
                                <span className="plan-row-name home-question">{question}</span>
                            </div>
                            <div className="plan-row-action home-row-arrow" aria-hidden="true">
                                ›
                            </div>
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    );
}
