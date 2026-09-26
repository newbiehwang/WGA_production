// 7계층 위치: 도구 호출·변경 작업 행의 팝업창 맨 위. 7계층을 고리로 그리고, 고른 계층의 설명을 오른쪽 카드에 보인다
// (질문·사용자 관리 행에는 계층이 없다).
//
//   7계층 위치                        ● 주의 3  ● 정상 3  ● 참고 1        ← 변경 작업 행: 이 작업의 판정 개수
//   질문 “로그대로 보존 기간 줄여줘”
//        ╭ 효과 ╮          ┌───────────────────────────────────────────┐
//     매개      •유출      │ 2 유출  Egress ⓘ                    [정상] │
//    경계   유출   체류     │ 승인 요청이 있습니다: …                      │
//     유입        판단      │ ─────────────────────────────────────── │
//        ╰────╯            │ 이 기록   변경 도구 … ─ 상태 승인 대기 ─ AWS … │
//                          │ 근거 기록 01:18:47 승인 요청: …               │
//                          │ 흔적 · 3 체류  읽은 결과 … ─ 의심 문구 3종 ─ … │
//                          └───────────────────────────────────────────┘
//
// 한 가지 뜻에는 한 가지 표시만 쓴다
// - 조각의 바탕색 = 이 작업의 판정 (정상 초록 · 주의 노랑 · 실패 빨강 · 참고 회색). 판정이 없는 도구 호출 행은 모두 옅은 중립색
// - 이 기록의 계층 = 조각 안 이름 위의 파란 점 하나
// - 고른 계층 = 고리 바깥의 선택 표시(둥근 호)가 미끄러져 가고, 조각 바탕이 조금 짙어진다. 처음에는 이 기록의 계층
// - 조각을 누르면(키보드는 Enter·Space) 그 계층을 고르고, 고른 조각을 다시 누르면 이 기록의 계층으로 돌아온다
// - 카드: 제목(번호 · 이름 · 영어 이름, 계층 정의는 ⓘ에) → 판정과 찾은 것 → 이 기록(이 기록의 계층일 때) → 근거 기록 → 흔적
//   판정이 없으면(도구 호출 행) 찾은 것 대신 계층 정의를 보인다
// - 판정은 서버가 작업의 기록만으로 계산한다 (GET /audit?trace=, services/llm/audit_trace.py). 팝업창을 열면 바로 받는다
// - 이 기록의 계층: 도구 반복이 정한다 (등록부에 없으면 경계, 변경 도구면 유출, 나머지는 유입. 변경 작업은 요청이 유출, 결정·실행이 효과)
// - 흔적: 체류(승인 요청 행의 taintedBy), 유입(도구 행의 의심 문구), 매개(실행한 AWS API의 요청 ID)
import { useEffect, useState, type ReactNode } from 'react';
import { fetchTrace } from '@/api/audit';
import type { AuditRecord, AuditTrace, TraceLayer, TraceStatus, TraceStep } from '@/types/audit';
import { ACTION_EVENTS, LAYERS, requesterOf, toolLabelOf } from './auditModel';
import { KST } from './timeWindow';

// ---------------------------------------------------------------- 판정 (서버의 역추적)
const STATUS_LABELS: Record<TraceStatus, string> = { ok: '정상', warn: '주의', fail: '실패', info: '참고' };
const STATUS_ORDER: TraceStatus[] = ['fail', 'warn', 'ok', 'info']; // 개수 요약의 차례 (나쁜 것부터)

// 근거 기록 한 줄: 시각(한국 시간 시:분:초)과 무엇
const clockOf = (record: AuditRecord) => new Date(Date.parse(record.at.split('#')[0]) + KST).toISOString().slice(11, 19);
const whatOf = (record: AuditRecord) => {
    if (record.kind === 'request') return `질문: ${record.question ?? ''}`;
    if (record.kind === 'action') return `${ACTION_EVENTS[record.event ?? '']?.label ?? record.event}: ${record.summary ?? record.tool ?? ''}`;
    return `${toolLabelOf(record.tool)} 호출`;
};

type TraceState = { status: 'none' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; trace: AuditTrace };

// 변경 작업 행이면 판정을 받는다 (팝업창을 열 때 한 번. 기록이 바뀌면 부르는 쪽이 새로 그린다)
function useTrace(record: AuditRecord): TraceState {
    const actionId = record.kind === 'action' ? record.actionId : undefined;
    const [state, setState] = useState<TraceState>(actionId ? { status: 'loading' } : { status: 'none' });
    useEffect(() => {
        if (!actionId) return;
        let cancelled = false;
        fetchTrace(actionId, record.day)
            .then((trace) => !cancelled && setState({ status: 'ready', trace }))
            .catch((error) => {
                if (cancelled) return;
                const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
                setState({ status: 'error', message: message ?? '판정을 불러오지 못했습니다' });
            });
        return () => {
            cancelled = true;
        };
    }, [actionId, record.day]);
    return state;
}

// 이 기록: 이 기록이 그 계층에 있는 까닭을 기록의 값으로 보인다. 문장 대신 흐름(단계 ─ 단계 ─ 단계)으로
//   유입  [도구 비용 조회] › [결과 3,449자] › [받는 곳 모델]
//   유출  [모델이 부름 로그 보존 기간 변경] › [위험도 변경] › [처리 승인 요청]
//   효과  [결정 승인] › [결정한 사람 kim@…] › [다음 실행]
// tone: 값의 뜻 (good 바뀌지 않음·데이터로만 다룸, bad 실패·미등록·의심 문구, change AWS가 바뀜)
interface EvidenceStep {
    label: string;
    value: string;
    sub?: string; // 작은 고정폭 글자 (도구 이름·이벤트 이름). 길면 말줄임
    hint?: string; // 마우스를 올리면 뜨는 전체 글 (말줄임한 값의 원문)
    tone?: 'good' | 'bad' | 'change';
}

function evidenceOf(record: AuditRecord): EvidenceStep[] {
    const tool = toolLabelOf(record.tool);
    if (record.kind === 'tool') {
        if (record.locus === 'interface')
            return [
                { label: '모델이 부름', value: tool, sub: record.tool },
                { label: '위험도 등록부', value: '없음', tone: 'bad' },
                { label: '처리', value: '변경 도구로 다룸 · 승인 요청' },
            ];
        if (record.locus === 'egress')
            return [
                { label: '모델이 부름', value: tool, sub: record.tool },
                { label: '위험도', value: '변경' },
                { label: '처리', value: '실행하지 않고 승인 요청', tone: 'good' },
            ];
        return [
            { label: '도구', value: tool, sub: record.tool },
            record.status === 'error'
                ? { label: '결과', value: '오류', tone: 'bad' }
                : {
                      label: '결과',
                      value: record.resultChars !== undefined ? `${record.resultChars.toLocaleString()}자` : '받음',
                  },
            { label: '받는 곳', value: '모델' },
        ];
    }
    const who = requesterOf(record);
    switch (record.event) {
        case 'requested':
            return [
                { label: '변경 도구', value: tool, sub: record.tool },
                { label: '상태', value: '승인 대기' },
                { label: 'AWS', value: '바뀌지 않음', tone: 'good' },
            ];
        case 'approved':
            return [
                { label: '결정', value: '승인' },
                { label: '결정한 사람', value: who },
                { label: '다음', value: '실행' },
            ];
        case 'denied':
            return [
                { label: '결정', value: '거절' },
                { label: '결정한 사람', value: who },
                { label: 'AWS', value: '바뀌지 않음', tone: 'good' },
            ];
        case 'executed':
            return [
                { label: '실행', value: tool, sub: record.tool },
                { label: '결과', value: '성공' }, // CloudTrail 이벤트는 매개의 흔적에서 보인다
                { label: 'AWS', value: '바뀜', tone: 'change' },
            ];
        case 'failed':
            return [
                { label: '실행', value: tool, sub: record.tool },
                { label: '결과', value: '실패', tone: 'bad' },
                { label: 'AWS', value: '확인 필요' },
            ];
        default:
            return [];
    }
}

// 흔적: 이 기록이 다른 계층에 남긴 표시. 근거처럼 값의 흐름으로 (한 계층에 흐름이 여럿일 수 있다: 체류의 의심 결과가 여럿)
//   체류  [읽은 결과 로그 분석] › [의심 문구 3종] › [변경 요청 바로 다음 호출]
//   유입  [도구 결과 로그 분석] › [의심 문구 3종] › [처리 데이터로만 다룸]
//   매개  [AWS API PutRetentionPolicy] › [요청 ID …] › [대조 CloudTrail 이벤트]
type Marks = Partial<Record<TraceLayer, EvidenceStep[][]>>;

// 의심 문구: 종류 수와 첫 종류(외 N), 전체는 마우스를 올리면
const kindsStep = (kinds: string[]): EvidenceStep => ({
    label: '의심 문구',
    value: `${kinds.length}종`,
    sub: kinds.length > 1 ? `${kinds[0]} 외 ${kinds.length - 1}` : kinds[0],
    hint: kinds.join(', '),
    tone: 'bad',
});

function marksOf(record: AuditRecord): Marks {
    const marks: Marks = {};
    if (record.taintedBy?.length)
        marks.residence = record.taintedBy.map((seen) => [
            { label: '읽은 결과', value: toolLabelOf(seen.tool), sub: seen.toolUseId },
            kindsStep(seen.kinds),
            { label: '변경 요청', value: seen.callsAgo <= 1 ? '바로 다음 호출' : `${seen.callsAgo}번째 뒤 호출` },
        ]);
    if (Array.isArray(record.injectionSuspected) && record.injectionSuspected.length)
        marks.ingress = [
            [
                { label: '도구 결과', value: toolLabelOf(record.tool), sub: record.tool },
                kindsStep(record.injectionSuspected),
                { label: '처리', value: '데이터로만 다룸', tone: 'good' },
            ],
        ];
    if (record.awsRequestId)
        marks.mediation = [
            [
                { label: 'AWS API', value: record.cloudTrailEvent?.split(':').pop() ?? '—', sub: record.cloudTrailEvent?.split(':')[0] },
                { label: '요청 ID', value: `${record.awsRequestId.slice(0, 8)}…`, hint: record.awsRequestId },
                { label: '대조', value: 'CloudTrail 이벤트의 requestID' },
            ],
        ];
    return marks;
}

// 값의 흐름: 상자 없이 이름표·값을 점과 가는 선으로 잇는다. 흐름이 여럿이면 줄로 쌓는다
function Flow({ flows }: { flows: EvidenceStep[][] }) {
    return (
        <div className="audit-flows">
            {flows
                .filter((steps) => steps.length)
                .map((steps, flowIndex) => (
                    <ol key={flowIndex} className="audit-flow">
                        {steps.map((step) => (
                            <li key={step.label} className={step.tone ? `is-${step.tone}` : undefined} title={step.hint}>
                                <span className="audit-flow-label">{step.label}</span>
                                <span className="audit-flow-value">{step.value}</span>
                                {step.sub ? <code className="audit-flow-sub">{step.sub}</code> : null}
                            </li>
                        ))}
                    </ol>
                ))}
        </div>
    );
}

// 카드의 한 구역: 왼쪽 이름표, 오른쪽 내용 (가는 선으로 나눈다)
function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="audit-card-section">
            <span className="audit-card-section-title">{title}</span>
            <div className="audit-card-section-body">{children}</div>
        </div>
    );
}

// 근거 기록: 판정의 답이 가리키는 행들 (시각 · 무엇)
function Cites({ step, trace }: { step: TraceStep; trace: AuditTrace }) {
    const records = [...trace.events, ...trace.rows];
    const cited = step.evidence
        .map((at) => records.find((record) => record.at === at))
        .filter((record): record is AuditRecord => Boolean(record))
        .sort((a, b) => (a.at < b.at ? -1 : 1));
    if (!cited.length) return null;
    return (
        <Section title="근거 기록">
            <ul className="audit-cites">
                {cited.map((record) => (
                    <li key={`${record.userId}|${record.at}`}>
                        <time>{clockOf(record)}</time>
                        <span title={whatOf(record)}>{whatOf(record)}</span>
                    </li>
                ))}
            </ul>
        </Section>
    );
}

// ---------------------------------------------------------------- 고리의 모양
const SIZE = 240;
const C = SIZE / 2; // 가운데
const R_OUT = 112; // 바깥 반지름
const R_IN = 70; // 안쪽 반지름
const R_MID = (R_OUT + R_IN) / 2;
const SPAN = 360 / LAYERS.length; // 조각 하나의 각 (도)
const GAP = 2.4; // 조각 사이 틈 (도)
const R_MARK = R_OUT + 8; // 선택 표시(호)의 반지름
const MARK_INSET = 6; // 선택 표시가 조각보다 양끝에서 짧은 각 (도)
const PAD = R_MARK - R_OUT + 6; // 그림 둘레의 여백

const rad = (deg: number) => (deg * Math.PI) / 180;
const at = (r: number, deg: number) => `${(C + r * Math.cos(rad(deg))).toFixed(2)} ${(C + r * Math.sin(rad(deg))).toFixed(2)}`;
// 조각 i의 가운데 각: 맨 위(-90°)에서 시계 방향. 차례는 서버가 묻는 차례 (1 효과 → 7 매개)
const midOf = (index: number) => -90 + index * SPAN;

// 고른 틈으로 나눈 평평한 조각 (바깥 호 → 안쪽 호)
function segmentPath(index: number) {
    const a0 = midOf(index) - SPAN / 2 + GAP / 2;
    const a1 = midOf(index) + SPAN / 2 - GAP / 2;
    return [
        `M ${at(R_OUT, a0)}`,
        `A ${R_OUT} ${R_OUT} 0 0 1 ${at(R_OUT, a1)}`,
        `L ${at(R_IN, a1)}`,
        `A ${R_IN} ${R_IN} 0 0 0 ${at(R_IN, a0)}`,
        'Z',
    ].join(' ');
}

// 선택 표시: 맨 위 조각(0번) 자리의 호. 고른 조각으로 돌려서(rotate) 옮긴다 (가운데가 원점인 좌표)
const MARK_PATH = (() => {
    const a0 = -90 - SPAN / 2 + GAP / 2 + MARK_INSET;
    const a1 = -90 + SPAN / 2 - GAP / 2 - MARK_INSET;
    const p = (deg: number) => `${(R_MARK * Math.cos(rad(deg))).toFixed(2)} ${(R_MARK * Math.sin(rad(deg))).toFixed(2)}`;
    return `M ${p(a0)} A ${R_MARK} ${R_MARK} 0 0 1 ${p(a1)}`;
})();

const labelAt = (index: number) => ({
    x: C + R_MID * Math.cos(rad(midOf(index))),
    y: C + R_MID * Math.sin(rad(midOf(index))),
});

export function AuditLayers({ record }: { record: AuditRecord }) {
    const hereIndex = LAYERS.findIndex((layer) => layer.id === record.locus);
    const here = LAYERS[hereIndex];
    const [picked, setPicked] = useState<TraceLayer | null>(null);
    const selectedIndex = picked ? LAYERS.findIndex((layer) => layer.id === picked) : hereIndex;
    const selected = LAYERS[selectedIndex];
    const selectedIsHere = selectedIndex === hereIndex;
    const marks = marksOf(record);
    const otherMarks = LAYERS.filter((layer) => marks[layer.id] && layer.id !== here?.id);

    const traceState = useTrace(record);
    const trace = traceState.status === 'ready' ? traceState.trace : null;
    const stepOf = (id: TraceLayer) => trace?.steps.find((step) => step.layer === id);
    const selectedStep = selected ? stepOf(selected.id) : undefined;
    // 판정 개수 (나쁜 것부터, 없는 판정은 뺀다)
    const counts = trace
        ? STATUS_ORDER.map((status) => ({ status, n: trace.steps.filter((step) => step.status === status).length })).filter(
              (count) => count.n,
          )
        : [];

    // 선택 표시의 회전각. 고른 조각이 바뀌면 가까운 쪽으로 돈다 (7 → 1은 한 칸 앞으로)
    const [turn, setTurn] = useState(selectedIndex * SPAN);
    useEffect(() => {
        const target = selectedIndex * SPAN;
        setTurn((previous) => previous + ((((target - previous) % 360) + 540) % 360) - 180);
    }, [selectedIndex]);

    return (
        <section className="audit-layers" aria-labelledby="audit-layers-title">
            <div className="audit-layers-head">
                <h4 id="audit-layers-title" className="audit-layers-title">
                    7계층 위치
                </h4>
                {counts.length ? (
                    <ul className="audit-counts" aria-label="이 작업의 판정 개수">
                        {counts.map(({ status, n }) => (
                            <li key={status} className={`is-${status}`}>
                                <span className="audit-counts-dot" aria-hidden="true" />
                                {STATUS_LABELS[status]} <strong>{n}</strong>
                            </li>
                        ))}
                    </ul>
                ) : traceState.status === 'loading' ? (
                    <span className="audit-counts-note" role="status">
                        <span className="plan-inline-spinner" aria-hidden="true" />
                        판정을 불러오는 중…
                    </span>
                ) : traceState.status === 'error' ? (
                    <span className="audit-counts-note is-error" role="alert">
                        {traceState.message}
                    </span>
                ) : null}
            </div>
            {trace?.question ? <p className="audit-layers-question">질문 “{trace.question}”</p> : null}

            <div className="audit-cycle">
                <svg
                    className="audit-cycle-svg"
                    viewBox={`${-PAD} ${-PAD} ${SIZE + PAD * 2} ${SIZE + PAD * 2}`}
                    role="group"
                    aria-label="7계층. 계층을 누르면 설명이 나옵니다"
                >
                    {LAYERS.map((layer, index) => {
                        const step = stepOf(layer.id);
                        const isHere = index === hereIndex;
                        const isSelected = index === selectedIndex;
                        const label = labelAt(index);
                        const state = [isHere ? '이 기록의 계층' : '', step ? STATUS_LABELS[step.status] : '']
                            .filter(Boolean)
                            .join(', ');
                        const choose = () => setPicked(isSelected || isHere ? null : layer.id);
                        return (
                            <g
                                key={layer.id}
                                className={`audit-cycle-seg is-${step?.status ?? 'none'}${isSelected ? ' is-selected' : ''}`}
                                style={{ animationDelay: `${index * 40}ms` }}
                                tabIndex={0}
                                role="button"
                                aria-pressed={isSelected}
                                aria-label={`${index + 1} ${layer.label} (${layer.en})${state ? `, ${state}` : ''}`}
                                onClick={choose}
                                onKeyDown={(event) => {
                                    if (event.key !== 'Enter' && event.key !== ' ') return;
                                    event.preventDefault(); // Space로 본문이 스크롤되지 않게
                                    choose();
                                }}
                            >
                                <path className="audit-cycle-shape" d={segmentPath(index)} />
                                {/* 이 기록의 계층: 이름 위의 파란 점 */}
                                {isHere ? <circle className="audit-cycle-here" cx={label.x} cy={label.y - 11} r={3.5} /> : null}
                                <text className="audit-cycle-label" x={label.x} y={label.y + (isHere ? 6 : 4.5)} textAnchor="middle">
                                    {layer.label}
                                </text>
                            </g>
                        );
                    })}
                    {/* 선택 표시: 고리 바깥의 둥근 호 (CSS transition으로 미끄러진다) */}
                    {selected ? (
                        <g transform={`translate(${C} ${C})`} aria-hidden="true">
                            <path className="audit-cycle-mark" d={MARK_PATH} style={{ transform: `rotate(${turn}deg)` }} />
                        </g>
                    ) : null}
                    {/* 가운데: 고른 계층의 이름 */}
                    {selected ? (
                        <text key={selected.id} x={C} y={C + 7} textAnchor="middle" className="audit-cycle-name" aria-hidden="true">
                            {selected.label}
                        </text>
                    ) : null}
                </svg>

                {/* 카드 (aria-live: 다른 계층을 고르면 화면 읽기 프로그램이 새 설명을 읽는다) */}
                {selected ? (
                    <div className="audit-card" aria-live="polite" key={selected.id}>
                        <div className="audit-card-head">
                            <span className={`audit-card-no${selectedIsHere ? ' is-here' : ''}`}>{selectedIndex + 1}</span>
                            <strong>{selected.label}</strong>
                            <span className="audit-card-en">{selected.en}</span>
                            <span className="audit-card-info" title={selected.description} aria-label={`정의: ${selected.description}`}>
                                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                                    <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                                    <path d="M8 7.2v3.6M8 5.1v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                </svg>
                            </span>
                            {selectedStep ? (
                                <span className={`audit-card-badge is-${selectedStep.status}`}>{STATUS_LABELS[selectedStep.status]}</span>
                            ) : null}
                        </div>
                        {/* 판정이 있으면 찾은 것, 없으면(도구 호출 행) 계층 정의 */}
                        <p className="audit-card-text">{selectedStep ? selectedStep.answer : selected.description}</p>

                        {selectedIsHere ? (
                            <Section title="이 기록">
                                <Flow flows={[evidenceOf(record)]} />
                            </Section>
                        ) : null}
                        {trace && selectedStep ? <Cites step={selectedStep} trace={trace} /> : null}
                        {marks[selected.id] ? (
                            <Section title="흔적">
                                <Flow flows={marks[selected.id]!} />
                            </Section>
                        ) : null}
                        {selectedIsHere
                            ? otherMarks.map((layer) => (
                                  <Section key={layer.id} title={`흔적 · ${LAYERS.indexOf(layer) + 1} ${layer.label}`}>
                                      <Flow flows={marks[layer.id]!} />
                                  </Section>
                              ))
                            : null}
                    </div>
                ) : null}
            </div>
        </section>
    );
}
