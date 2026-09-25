// 메시지 하나 (예전 components/ChatMessage.vue).
// 내 질문은 오른쪽에 글씨만, 답변은 말풍선 없이 본문으로.
// 답변 위에는 답을 만든 과정(사고 요약·도구 호출)을 순서대로 보여 준다 (ProgressTrace).
// 답을 기다리는 동안에는 같은 자리에 진행 상황과 '생각하는 중… (12초)'이 보인다.
// AI가 AWS를 바꾸려 했으면 답변 아래에 승인 카드가 나온다 (inference.pendingActions, ApprovalCard).
// 답변 속 ![제목](artifact://…)은 결과물(차트·다이어그램)이다. inference.artifacts로 풀어 ArtifactView로 그린다.
import { memo, useMemo, useState } from 'react';
import agentLogo from '@/assets/agent-logo.png';
import type { PendingAction } from '@/types/actions';
import type { ChatMessageType } from '@/types/chat';
import { artifactsOf, splitArtifacts } from '@/utils/artifacts';
import { parseMarkdown } from '@/utils/markdown';
import { fromProgressSteps, traceSteps } from '@/utils/toolTrace';
import { ApprovalCard } from './ApprovalCard';
import { ArtifactView } from './ArtifactView';
import { ProgressTrace } from './ProgressTrace';

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

// 답변의 승인 요청 (저장된 메시지에서는 inference가 JSON 문자열이다)
const pendingActionsOf = (inference: unknown): PendingAction[] => {
    let data = inference;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            return [];
        }
    }
    const actions = (data as { pendingActions?: unknown } | null)?.pendingActions;
    return Array.isArray(actions) ? (actions as PendingAction[]) : [];
};

function ChatMessageView({ message }: { message: ChatMessageType }) {
    const [showDetails, setShowDetails] = useState(false);
    const isUser = message.sender === 'user';
    // 기다리는 중이면 진행 상황의 단계, 답이 왔으면 답변에 저장된 단계
    const steps = useMemo(
        () =>
            isUser ? [] : message.isTyping ? fromProgressSteps(message.progress?.steps) : traceSteps(message.inference),
        [isUser, message.isTyping, message.progress, message.inference],
    );
    // 타이핑 중이면 지금까지 보여 준 만큼만 (빈 글자일 때 전체가 잠깐 보이지 않게)
    const shownText = message.animationState === 'typing' ? (message.displayText ?? '') : message.text;
    // 글 조각은 마크다운으로, 결과물 조각은 컴포넌트로 (타이핑 중 참조가 덜 나왔으면 아직 글로 보인다)
    const segments = useMemo(
        () =>
            splitArtifacts(shownText || '').map((segment) =>
                segment.kind === 'text' ? { ...segment, html: parseMarkdown(escapeHtml(segment.text)) } : segment,
            ),
        [shownText],
    );
    const artifacts = useMemo(() => (isUser ? new Map() : artifactsOf(message.inference)), [isUser, message.inference]);
    const rows = useMemo(() => rowsOf(message.query_result), [message.query_result]);
    const actions = useMemo(() => (isUser ? [] : pendingActionsOf(message.inference)), [isUser, message.inference]);
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
                <ProgressTrace
                    steps={steps}
                    live={
                        message.isTyping
                            ? { phase: message.progress?.phase ?? 'thinking', since: message.timestamp }
                            : undefined
                    }
                />

                {message.isTyping ? null : (
                    <div className="message-content markdown-content">
                        {segments.map((segment, index) =>
                            segment.kind === 'text' ? (
                                <div key={index} dangerouslySetInnerHTML={{ __html: segment.html }} />
                            ) : (
                                <ArtifactView key={index} artifact={artifacts.get(segment.ref)} title={segment.title} />
                            ),
                        )}
                    </div>
                )}

                {/* 답변을 다 보여 준 뒤에 승인 카드를 보여 준다 (타이핑 중에 버튼이 먼저 보이지 않게) */}
                {actions.length > 0 && !message.isTyping && message.animationState !== 'typing'
                    ? actions.map((action) => <ApprovalCard key={action.actionId} action={action} />)
                    : null}

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
