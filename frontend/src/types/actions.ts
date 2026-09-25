// 변경 작업 승인 요청 (services/llm/approvals.py의 public_view와 같은 모양).
// 답변의 inference.pendingActions와 GET·POST /actions/{actionId}의 응답이 이 모양이다

export type ActionStatus = 'pending' | 'approved' | 'denied' | 'executing' | 'executed' | 'failed' | 'expired';

export interface PendingAction {
    actionId: string;
    tool: string; // 변경 도구 이름 (setLogRetention 등)
    args: Record<string, unknown>; // 승인하면 실제로 실행될 인자 (가리지 않는다)
    summary: string; // 예: "/aws/lambda/wga-llm-dev 로그 보존 기간 30일 → 14일 (지난 로그 일부가 지워질 수 있습니다)"
    before?: string;
    after?: string;
    status: ActionStatus;
    requesterId?: string;
    createdAt: number; // 초 (epoch)
    expiresAt: number; // 초 (epoch). 이때까지 승인하지 않으면 만료된다 (10분)
    decidedBy?: string;
    decidedAt?: number;
    result?: string; // 실행 결과 (MCP 도구가 돌려준 글)
    // 이 변경이 CloudTrail에 남긴 이벤트를 찾을 단서. CloudTrail 이벤트의 requestID가 request_id와 같다
    cloudtrail?: { event_source: string; event_name: string; request_id: string };
}
