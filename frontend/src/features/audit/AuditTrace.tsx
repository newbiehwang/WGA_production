// 역추적: 변경 작업 하나를 놓고 "어디가 뚫렸나"를 층 하나씩 아래에서 위로 묻는다 (GET /audit?trace=, services/llm/audit_trace.py).
// 감사 로그에서 변경 작업 행을 펼치고 '층별로 따져 보기'를 누르면 보인다.
//
//   ⚠ 주의할 층이 있습니다. 경고가 붙은 층부터 확인하세요
//   질문: "최근 오류 로그 보여줘"
//   1 효과  실행됐는가? 사람이 승인했는가?          정상  사람이 승인해 실행했습니다 (승인: bob@…)
//   2 유출  게이트를 거친 승인 요청 기록이 있는가?   정상  …
//   3 체류  요청 전에 의심 문구가 든 결과를 읽었는가? 주의  …
//   …
//   기록: 시각 · 누가 · 무엇을 · [이 행을 근거로 든 물음 번호]
//
// 답은 서버가 기록만으로 계산한다 (같은 기록이면 언제나 같은 답). 화면은 보여 주기만 한다.
import { useEffect, useState } from 'react';
import { fetchTrace } from '@/api/audit';
import type { AuditRecord, AuditTrace as Trace, TraceLayer, TraceStatus } from '@/types/audit';
import { formatKoreanDateTimeSeconds } from '@/utils/formatters';
import { labelOf } from '@/utils/toolTrace';

const LAYERS: Record<TraceLayer, string> = {
    effect: '효과',
    egress: '유출',
    residence: '체류',
    deliberation: '판단',
    ingress: '유입',
    interface: '경계',
    mediation: '매개',
};

const STATUSES: Record<TraceStatus, string> = { ok: '정상', warn: '주의', fail: '실패', info: '참고' };

const EVENTS: Record<string, string> = {
    requested: '승인 요청',
    approved: '승인',
    denied: '거절',
    executed: '실행',
    failed: '실행 실패',
};

const timeOf = (record: AuditRecord) => record.at.split('#')[0];
const whoOf = (record: AuditRecord) => record.email ?? record.userId;

const whatOf = (record: AuditRecord) => {
    if (record.kind === 'request') return `질문: ${record.question ?? ''}`;
    if (record.kind === 'action') return `${EVENTS[record.event ?? ''] ?? record.event}: ${record.summary ?? record.tool ?? ''}`;
    return `${labelOf(record.tool ?? '')} 호출`;
};

// 가장 나쁜 상태 (참고는 세지 않는다): 맨 위 결론의 색
const worstOf = (trace: Trace): TraceStatus =>
    trace.steps.some((step) => step.status === 'fail')
        ? 'fail'
        : trace.steps.some((step) => step.status === 'warn')
          ? 'warn'
          : 'ok';

const errorText = (error: unknown) => {
    const response = (error as { response?: { data?: { error?: string } } })?.response;
    return response?.data?.error ?? '역추적을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
};

export function AuditTrace({ actionId, day }: { actionId: string; day: string }) {
    const [trace, setTrace] = useState<Trace | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setTrace(null);
        setError(null);
        fetchTrace(actionId, day)
            .then((result) => !cancelled && setTrace(result))
            .catch((err) => !cancelled && setError(errorText(err)));
        return () => {
            cancelled = true;
        };
    }, [actionId, day]);

    if (error)
        return (
            <p className="audit-trace-error" role="alert">
                {error}
            </p>
        );
    if (!trace)
        return (
            <div className="audit-trace-loading" role="status">
                <div className="plan-inline-spinner" />
                <span>기록을 모으는 중…</span>
            </div>
        );

    // 행마다 그 행을 근거로 든 물음 번호
    const citedBy = new Map<string, number[]>();
    trace.steps.forEach((step, index) =>
        step.evidence.forEach((at) => citedBy.set(at, [...(citedBy.get(at) ?? []), index + 1])),
    );
    const records = [...trace.events, ...trace.rows].sort((a, b) => (timeOf(a) < timeOf(b) ? -1 : 1));

    return (
        <section className="audit-trace" aria-label="역추적">
            <p className={`audit-trace-verdict is-${worstOf(trace)}`}>{trace.verdict}</p>
            {trace.question ? <p className="audit-trace-question">질문: “{trace.question}”</p> : null}

            <ol className="audit-trace-steps">
                {trace.steps.map((step, index) => (
                    <li key={step.layer} className={`audit-trace-step is-${step.status}`}>
                        <span className="audit-trace-no" aria-hidden="true">
                            {index + 1}
                        </span>
                        <div className="audit-trace-body">
                            <p className="audit-trace-head">
                                <strong className="audit-trace-layer">{LAYERS[step.layer]}</strong>
                                <span className="audit-trace-q">{step.question}</span>
                                <span className={`audit-trace-status is-${step.status}`}>{STATUSES[step.status]}</span>
                            </p>
                            <p className="audit-trace-answer">{step.answer}</p>
                        </div>
                    </li>
                ))}
            </ol>

            <h3 className="audit-trace-subtitle">기록 ({records.length}건)</h3>
            <ul className="audit-trace-timeline">
                {records.map((record) => {
                    const cited = citedBy.get(record.at) ?? [];
                    return (
                        <li key={`${record.userId}|${record.at}`} className={cited.length ? 'is-cited' : undefined}>
                            <span className="audit-trace-time">{formatKoreanDateTimeSeconds(timeOf(record))}</span>
                            <span className="audit-trace-who">{whoOf(record)}</span>
                            <span className="audit-trace-what">{whatOf(record)}</span>
                            {cited.length ? (
                                <span className="audit-trace-cited" title="이 행을 근거로 든 물음">
                                    {cited.join('·')}
                                </span>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
