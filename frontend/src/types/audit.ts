// 감사 로그 (GET /audit, services/llm/audit.py)와 같은 모양

export type AuditKind = 'tool' | 'request' | 'action';
export type AuditStatus = 'ok' | 'error';
export type AuditScope = 'mine' | 'all' | 'user';

export interface AuditRecord {
    userId: string; // 웹은 Cognito sub, Slack은 'slack:<사용자 ID>'
    at: string; // 시각(UTC, 밀리초까지) + '#' + 도구 호출 ID 또는 'request#<질문 ID>'
    day: string; // YYYY-MM-DD (UTC)
    kind: AuditKind;
    status: AuditStatus;
    source?: 'web' | 'slack' | 'direct';
    email?: string;
    requestId?: string;
    sessionId?: string;
    ms?: number; // 걸린 시간
    error?: string;
    // 도구 호출 (kind: 'tool')
    tool?: string;
    toolUseId?: string;
    input?: Record<string, unknown> | string; // 길어서 잘린 입력은 글자로 온다
    resultChars?: number;
    // 지시문처럼 보이는 문구 (services/llm/injection.py). 도구 호출은 종류 목록, 질문은 그런 도구 결과의 수
    injectionSuspected?: string[] | number;
    // 질문 (kind: 'request')
    question?: string;
    model?: string;
    toolCount?: number;
    redacted?: Record<string, number>; // Claude로 보내기 전에 가린 값의 수 (종류별)
    // 변경 작업의 사건 (kind: 'action', services/llm/approvals.py)
    event?: 'requested' | 'approved' | 'denied' | 'executed' | 'failed';
    actionId?: string;
    summary?: string; // 예: "보존 기간 30일 → 14일"
    decidedBy?: string; // 승인·거절한 사람 (Cognito sub)
    result?: string; // 실행 결과
}

export interface AuditPage {
    items: AuditRecord[];
    cursor: string | null; // 더 있으면 다음 조회에 넘긴다
    scope: AuditScope;
    isAdmin: boolean; // Cognito admins 그룹이면 모든 사용자의 기록을 볼 수 있다
    from: string;
    to: string;
}

export interface AuditQuery {
    from?: string;
    to?: string;
    scope?: 'mine' | 'all';
    user?: string;
    tool?: string;
    status?: AuditStatus;
    kind?: AuditKind;
    limit?: number;
    cursor?: string;
}
