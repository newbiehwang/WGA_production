// 변경 작업 승인 카드: AI가 AWS를 바꾸려 할 때 답변 아래에 나온다 (services/llm/approvals.py).
//
//   ⚠ 승인 필요 · 로그 보존 기간 변경            남은 시간 9:41
//   /aws/lambda/wga-llm-dev 로그 보존 기간 30일 → 14일 (지난 로그 일부가 지워질 수 있습니다)
//   30일 → 14일
//   실행될 값  log_group_name /aws/lambda/wga-llm-dev · retention_days 14
//   (먼저 읽은 결과에 의심 문구가 있었으면) 로그 조회 결과 · 바로 다음 호출 — 사용자의 뜻인지 확인하세요
//   [거절]  [승인하고 실행]
//
// - 승인하면 서버가 실행하고 결과를 돌려준다. 그 뒤 '승인: …' 메시지와 함께 모델이 결과를 설명한다 (explainAction).
// - 거절하면 실행하지 않는다. 모델 설명은 부르지 않는다.
// - 답변에 저장된 상태는 요청 당시의 것이다. 대화를 다시 열면 서버에서 지금 상태를 다시 읽는다.
// - 승인 버튼 하나로 실행된다: 카드 자체가 무엇이 바뀌는지 보여 주는 확인 단계다.
import { useEffect, useState } from 'react';
import { actionErrorText, decideAction, getAction } from '@/api/actions';
import { useChatStore } from '@/stores/chatStore';
import type { PendingAction, TaintedBy } from '@/types/actions';
import { labelOf } from '@/utils/toolTrace';

const STATUS_TEXT: Record<string, string> = {
    approved: '승인했습니다. 실행하는 중입니다…',
    executing: '실행하는 중입니다…',
    executed: '승인해 실행했습니다.',
    failed: '승인했지만 실행하지 못했습니다.',
    denied: '거절했습니다. 아무것도 바뀌지 않았습니다.',
    expired: '승인 시간(10분)이 지나 실행하지 않았습니다. 필요하면 다시 요청해 주세요.',
};

// 남은 시간 (1초마다 다시 그린다). 0이 되면 만료로 본다
function useRemainingSeconds(expiresAt: number, active: boolean) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [active]);
    return Math.max(0, Math.floor(expiresAt - now / 1000));
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const valueText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

// 의심 결과와 이 요청 사이의 거리: 1이면 그 결과를 읽자마자 요청했다
const distanceText = (seen: TaintedBy) => (seen.callsAgo <= 1 ? '바로 다음 호출' : `${seen.callsAgo}번째 뒤 호출`);

export function ApprovalCard({ action: initial }: { action: PendingAction }) {
    const [action, setAction] = useState(initial);
    const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const waiting = useChatStore((s) => s.waitingForResponse);
    const remaining = useRemainingSeconds(action.expiresAt, action.status === 'pending');
    const status = action.status === 'pending' && remaining === 0 ? 'expired' : action.status;
    const open = status === 'pending';

    // 대화를 다시 열었을 때: 저장된 답변의 상태는 요청 당시 것이므로 지금 상태를 읽는다
    useEffect(() => {
        if (initial.status !== 'pending') return;
        let cancelled = false;
        getAction(initial.actionId)
            .then((latest) => !cancelled && setAction(latest))
            .catch(() => {}); // 못 읽으면 저장된 상태와 남은 시간으로 보여 준다
        return () => {
            cancelled = true;
        };
    }, [initial.actionId, initial.status]);

    const decide = async (decision: 'approve' | 'deny') => {
        setBusy(decision);
        setError(null);
        try {
            const latest = await decideAction(action.actionId, decision);
            setAction(latest);
            // 승인해 실행했으면(실패 포함) 결과를 모델이 이어서 설명한다. 질문은 서버가 저장된 기록으로 만든다
            if (decision === 'approve' && (latest.status === 'executed' || latest.status === 'failed')) {
                useChatStore.getState().explainAction(latest.actionId, `승인: ${latest.summary}`);
            }
        } catch (err) {
            setError(actionErrorText(err));
            // 이미 결정되었거나 만료된 요청이면 지금 상태로 바꿔 둔다
            getAction(action.actionId).then(setAction).catch(() => {});
        } finally {
            setBusy(null);
        }
    };

    const args = Object.entries(action.args ?? {});

    return (
        <section className={`approval-card is-${status}`} aria-label="변경 작업 승인 요청">
            <header className="approval-head">
                <span className="approval-badge">{open ? '승인 필요' : '변경 작업'}</span>
                <span className="approval-tool" title={action.tool}>
                    {labelOf(action.tool).replace(/ 요청$/, '')}
                </span>
                {open ? (
                    <span className="approval-timer" aria-label={`남은 시간 ${clock(remaining)}`}>
                        남은 시간 {clock(remaining)}
                    </span>
                ) : null}
            </header>

            <p className="approval-summary">{action.summary}</p>

            {action.before || action.after ? (
                <p className="approval-change">
                    <span className="approval-before">{action.before ?? '-'}</span>
                    <span className="approval-arrow" aria-label="에서">
                        →
                    </span>
                    <span className="approval-after">{action.after ?? '-'}</span>
                </p>
            ) : null}

            {args.length ? (
                <dl className="approval-args" aria-label="승인하면 실행될 값">
                    {args.map(([key, value]) => (
                        <div key={key} className="approval-arg">
                            <dt>{key}</dt>
                            <dd>
                                <code>{valueText(value)}</code>
                            </dd>
                        </div>
                    ))}
                </dl>
            ) : null}

            {action.taintedBy?.length ? (
                // 체류 신호 (services/llm/approvals.py): 결정은 그대로이고, 승인자가 무엇을 의심할지 알려 준다
                <div className="approval-tainted" role="note">
                    <p className="approval-tainted-title">
                        이 요청 전에 읽은 도구 결과에 지시문처럼 보이는 문구가 있었습니다
                    </p>
                    <ul className="approval-tainted-list">
                        {action.taintedBy.map((seen) => (
                            <li key={seen.toolUseId} title={seen.kinds.join(', ')}>
                                {labelOf(seen.tool)} 결과 · {distanceText(seen)}에서 이 변경을 요청
                            </li>
                        ))}
                    </ul>
                    <p className="approval-tainted-hint">
                        사용자가 원한 변경인지, 로그·문서에 심긴 지시를 따른 것인지 확인한 뒤 승인하세요.
                    </p>
                </div>
            ) : null}

            {open ? (
                <div className="approval-actions">
                    <button
                        type="button"
                        className="plan-reload-button"
                        onClick={() => decide('deny')}
                        disabled={busy !== null}
                    >
                        {busy === 'deny' ? '거절하는 중…' : '거절'}
                    </button>
                    <button
                        type="button"
                        className="plan-create-button"
                        onClick={() => decide('approve')}
                        // 다른 답을 기다리는 중에는 승인하지 않는다 (결과 설명이 그 답과 섞이지 않게)
                        disabled={busy !== null || waiting}
                    >
                        {busy === 'approve' ? '실행하는 중…' : '승인하고 실행'}
                    </button>
                </div>
            ) : (
                <p className="approval-status" role="status">
                    {STATUS_TEXT[status] ?? status}
                </p>
            )}

            {status === 'failed' && action.result ? <p className="approval-result">{action.result}</p> : null}
            {status === 'executed' && action.cloudtrail ? (
                // 앱의 승인 기록과 AWS의 변경 기록(CloudTrail)을 잇는 열쇠. 보통 몇 분 뒤 CloudTrail에서 조회된다
                <p className="approval-trail">
                    CloudTrail: {action.cloudtrail.event_name} · 요청 ID <code>{action.cloudtrail.request_id}</code>
                </p>
            ) : null}
            {error ? (
                <p className="approval-error" role="alert">
                    {error}
                </p>
            ) : null}
        </section>
    );
}
