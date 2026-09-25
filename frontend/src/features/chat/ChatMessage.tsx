// 메시지 하나 (예전 components/ChatMessage.vue).
// 내 질문은 오른쪽에 글씨만, 답변은 말풍선 없이 본문으로. 답변 위에는 답을 만들며 부른 도구를 세로줄 목록으로 보여 준다.
import { memo, useMemo, useState } from 'react';
import agentLogo from '@/assets/agent-logo.png';
import type { ChatMessageType } from '@/types/chat';
import { parseMarkdown } from '@/utils/markdown';
import { toolSteps } from '@/utils/toolTrace';

// 마크다운 파서(utils/markdown.ts)는 HTML 특수 문자를 이미 escape한 글을 받는다.
// 답변에 들어 있는 <script> 같은 글자가 HTML로 실행되지 않게 먼저 바꾼다
const escapeHtml = (text: string) =>
    text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

// 추론 데이터는 저장된 메시지에서는 JSON 문자열, 방금 받은 답변에서는 객체다. 보기 좋게 들여 쓴 글로 바꾼다
const prettyJson = (value: unknown): string => {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return JSON.stringify(parsed, null, 2);
    } catch {
        return String(value);
    }
};

// 저장된 메시지의 쿼리 결과도 JSON 문자열이다
const rowsOf = (value: unknown): Record<string, unknown>[] => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
};

function ChatMessageView({ message }: { message: ChatMessageType }) {
    const [showDetails, setShowDetails] = useState(false);
    const isUser = message.sender === 'user';
    const steps = useMemo(() => (isUser ? [] : toolSteps(message.inference)), [isUser, message.inference]);
    // 타이핑 중이면 지금까지 보여 준 만큼만 (빈 글자일 때 전체가 잠깐 보이지 않게)
    const shownText = message.animationState === 'typing' ? (message.displayText ?? '') : message.text;
    const html = useMemo(() => parseMarkdown(escapeHtml(shownText || '')), [shownText]);
    const rows = useMemo(() => rowsOf(message.query_result), [message.query_result]);
    const hasMeta = !isUser && (message.elapsed_time || message.inference);

    return (
        <div
            className={`message ${isUser ? 'user-message' : 'bot-message'}${
                message.animationState === 'appear' ? ' appear-animation' : ''
            }`}
        >
            {!isUser ? (
                <div className="message-avatar" aria-hidden="true">
                    <img src={agentLogo} alt="" />
                </div>
            ) : null}

            <div className="message-body">
                {steps.length > 0 ? (
                    // 실패는 색이 아니라 모양(— 와 굵기)으로 구분한다
                    <ol className="tool-trace" aria-label="사용한 도구">
                        {steps.map((step, index) => (
                            <li key={index} className={`tool-step${step.failed ? ' failed' : ''}`} title={step.name}>
                                <span className="tool-step-title">
                                    {step.failed ? '—' : '✓'} {step.label}
                                    {step.failed ? ' — 실패' : ''}
                                </span>
                                {step.detail ? <span className="tool-step-detail">{step.detail}</span> : null}
                                {step.error ? <span className="tool-step-detail tool-step-error">{step.error}</span> : null}
                            </li>
                        ))}
                    </ol>
                ) : null}

                {message.isTyping ? (
                    <div className="typing-indicator" role="status" aria-label="답변을 만드는 중">
                        <span className="dot" />
                        <span className="dot" />
                        <span className="dot" />
                    </div>
                ) : (
                    <div className="message-content markdown-content" dangerouslySetInnerHTML={{ __html: html }} />
                )}

                {hasMeta ? (
                    <div className="query-metadata">
                        {message.elapsed_time ? <span className="elapsed-time">실행 시간 {message.elapsed_time}</span> : null}
                        <button type="button" className="details-toggle" onClick={() => setShowDetails((v) => !v)}>
                            {showDetails ? '간략히 보기 ▲' : '자세히 보기 ▼'}
                        </button>

                        {showDetails ? (
                            <div className="query-details">
                                {message.query_string ? (
                                    <div className="query-section">
                                        <h4>SQL 쿼리</h4>
                                        <pre className="query-code">{message.query_string}</pre>
                                    </div>
                                ) : null}

                                {rows.length > 0 ? (
                                    <div className="query-section">
                                        <h4>쿼리 결과</h4>
                                        <div className="markdown-table-container">
                                            <table className="markdown-table">
                                                <thead>
                                                    <tr>
                                                        {Object.keys(rows[0]).map((key) => (
                                                            <th key={key}>{key}</th>
                                                        ))}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {rows.map((row, rowIndex) => (
                                                        <tr key={rowIndex}>
                                                            {Object.entries(row).map(([key, value]) => (
                                                                <td key={key}>
                                                                    {typeof value === 'string'
                                                                        ? value.replace(/\\n/g, ' ')
                                                                        : String(value)}
                                                                </td>
                                                            ))}
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                ) : null}

                                {message.inference ? (
                                    <div className="query-section">
                                        <h4>추론 데이터</h4>
                                        <pre className="query-code">{prettyJson(message.inference)}</pre>
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

// 타이핑 중인 답변 하나가 바뀔 때 다른 메시지는 다시 그리지 않는다
export const ChatMessage = memo(ChatMessageView);
