// 층 다이어그램: 7계층을 고리 모양의 순환 다이어그램으로 그린다. 도구 호출·변경 작업 행의 팝업창 맨 위에 보인다
// (질문·사용자 관리 행에는 층이 없다).
//
//        ╭ 효과 ╮                     5 유입                         [이 기록]
//     매개      유출 ▸               비용 조회의 결과가 모델에게 들어갔습니다
//    경계   유입    체류              ─────────────
//     ▸[유입]    판단                흔적
//        ╰────╯                      ● 3 체류 · 의심 문구가 든 결과를 읽은 뒤 요청한 변경입니다 (1건)
//
// - 고리는 조각 7개다. 조각 끝이 뾰족해(셰브런) 따로 화살표 없이 도는 방향이 보인다.
//   차례는 역추적('층별로 따져 보기', services/llm/audit_trace.py)이 묻는 차례다 (맨 위 1 효과부터 시계 방향)
// - 이 기록의 층(행의 locus): 파랑으로 채우고 바깥으로 조금 밀어낸다. 흔적이 있는 층: 옅은 주황.
//   기록으로 남지 않는 층(판단: 모델 안, 매개: 앱 밖): 점선 테두리
// - 오른쪽 설명 칸: 평소에는 이 기록이 한 일과 흔적. 조각에 마우스를 올리거나 키보드로 옮겨 가면 그 층의 설명으로 바뀐다
// - 이 기록의 층: 도구 반복이 정한다 (등록부에 없으면 경계, 변경 도구면 유출, 나머지는 유입. 변경 작업은 요청이 유출, 결정·실행이 효과)
// - 흔적: 체류(승인 요청 행의 taintedBy), 유입(도구 행의 의심 문구), 매개(실행한 AWS API의 요청 ID)
import { useState, type CSSProperties } from 'react';
import type { AuditRecord, TraceLayer } from '@/types/audit';
import { LAYERS, toolLabelOf } from './auditModel';

// 이 기록이 그 층에서 한 일
function hereText(record: AuditRecord): string {
    const tool = toolLabelOf(record.tool);
    if (record.kind === 'tool') {
        if (record.locus === 'interface') return `등록부에 없는 도구 ${tool}을(를) 불렀습니다. 변경 도구로 다뤄 승인을 요청합니다`;
        if (record.locus === 'egress') return `변경 도구 ${tool}을(를) 불렀습니다. 실행하지 않고 승인을 요청합니다`;
        return `${tool}의 결과가 모델에게 들어갔습니다`;
    }
    switch (record.event) {
        case 'requested':
            return '승인 요청을 만들었습니다. 아직 AWS는 바뀌지 않았습니다';
        case 'approved':
            return '사람이 승인했습니다';
        case 'denied':
            return '사람이 거절했습니다. AWS는 바뀌지 않았습니다';
        case 'executed':
            return '실행했습니다. AWS가 바뀌었습니다';
        case 'failed':
            return '실행하다 실패했습니다';
        default:
            return '';
    }
}

// 이 기록이 다른 층에 남긴 흔적
function marksOf(record: AuditRecord): Partial<Record<TraceLayer, string>> {
    const marks: Partial<Record<TraceLayer, string>> = {};
    if (record.taintedBy?.length)
        marks.residence = `의심 문구가 든 결과를 읽은 뒤 요청한 변경입니다 (${record.taintedBy.length}건)`;
    if (Array.isArray(record.injectionSuspected) && record.injectionSuspected.length)
        marks.ingress = `결과에 지시문처럼 보이는 문구가 있었습니다 (${record.injectionSuspected.join(', ')})`;
    if (record.awsRequestId) marks.mediation = `CloudTrail 요청 ID ${record.awsRequestId}로 대조합니다`;
    return marks;
}

// 기록 방식 (설명 칸의 작은 글)
const RECORDED_TEXT = {
    row: '기록: 행으로 남는다',
    flag: '기록: 행이 따로 없고, 승인 요청 행의 표시(의심 뒤 요청)로 남는다',
    none: '기록: 남지 않는다 (모델 안)',
    outside: '기록: 앱 밖 (AWS CloudTrail)',
} as const;

// ---------------------------------------------------------------- 고리의 모양
const SIZE = 240;
const C = SIZE / 2; // 가운데
const R_OUT = 112; // 바깥 반지름
const R_IN = 72; // 안쪽 반지름
const R_MID = (R_OUT + R_IN) / 2;
const SPAN = 360 / LAYERS.length; // 조각 하나의 각 (도)
const GAP = 2.2; // 조각 사이 틈 (도)
const TIP = 5; // 셰브런의 뾰족한 끝이 나아가는 각 (도)
const POP = 6; // 이 기록의 조각을 바깥으로 밀어내는 거리

const rad = (deg: number) => (deg * Math.PI) / 180;
const at = (r: number, deg: number) => `${(C + r * Math.cos(rad(deg))).toFixed(2)} ${(C + r * Math.sin(rad(deg))).toFixed(2)}`;
// 조각 i의 가운데 각: 맨 위(-90°)에서 시계 방향
const midOf = (index: number) => -90 + index * SPAN;

// 셰브런 조각: 바깥 호 → 앞쪽 뾰족한 끝 → 안쪽 호 → 뒤쪽 오목한 홈
function segmentPath(index: number) {
    const a0 = midOf(index) - SPAN / 2 + GAP / 2;
    const a1 = a0 + SPAN - GAP;
    return [
        `M ${at(R_OUT, a0)}`,
        `A ${R_OUT} ${R_OUT} 0 0 1 ${at(R_OUT, a1)}`,
        `L ${at(R_MID, a1 + TIP)}`,
        `L ${at(R_IN, a1)}`,
        `A ${R_IN} ${R_IN} 0 0 0 ${at(R_IN, a0)}`,
        `L ${at(R_MID, a0 + TIP)}`,
        'Z',
    ].join(' ');
}

// 조각 안 글자의 자리 (셰브런 끝만큼 앞으로 치우친 가운데)
const labelAt = (index: number) => {
    const deg = midOf(index) + TIP / 2;
    return { x: C + R_MID * Math.cos(rad(deg)), y: C + R_MID * Math.sin(rad(deg)) };
};

export function AuditLayers({ record }: { record: AuditRecord }) {
    const [focus, setFocus] = useState<TraceLayer | null>(null);
    const marks = marksOf(record);
    const hereIndex = LAYERS.findIndex((layer) => layer.id === record.locus);
    const here = LAYERS[hereIndex];
    // 설명 칸에 보일 층: 마우스·키보드로 짚은 층, 없으면 이 기록의 층
    const shownIndex = focus ? LAYERS.findIndex((layer) => layer.id === focus) : hereIndex;
    const shown = LAYERS[shownIndex];
    const showingHere = shown?.id === here?.id;
    const otherMarks = LAYERS.filter((layer) => marks[layer.id] && layer.id !== here?.id);

    return (
        <section className="audit-layers" aria-labelledby="audit-layers-title">
            <h4 id="audit-layers-title" className="audit-layers-title">
                층 <span className="audit-muted">7계층에서 이 기록의 자리</span>
            </h4>

            <div className="audit-cycle">
                <svg
                    className="audit-cycle-svg"
                    viewBox={`${-POP} ${-POP} ${SIZE + POP * 2} ${SIZE + POP * 2}`}
                    role="group"
                    aria-label="7계층 순환 다이어그램. 층을 짚으면 오른쪽에 설명이 나옵니다"
                    onMouseLeave={() => setFocus(null)}
                >
                    {LAYERS.map((layer, index) => {
                        const isHere = index === hereIndex;
                        const isMarked = !isHere && Boolean(marks[layer.id]);
                        const offRecord = layer.recorded === 'none' || layer.recorded === 'outside';
                        const mid = rad(midOf(index));
                        const label = labelAt(index);
                        const state = isHere ? '이 기록의 층' : isMarked ? '흔적' : offRecord ? '기록으로 남지 않음' : '';
                        return (
                            <g
                                key={layer.id}
                                className={`audit-cycle-seg${isHere ? ' is-here' : isMarked ? ' is-marked' : ''}${
                                    offRecord ? ' is-off-record' : ''
                                }${focus === layer.id ? ' is-focus' : ''}`}
                                // 이 기록의 조각은 가운데에서 바깥으로 밀어낸다 (--dx·--dy: CSS가 transform으로)
                                style={
                                    {
                                        '--dx': `${(POP * Math.cos(mid)).toFixed(2)}px`,
                                        '--dy': `${(POP * Math.sin(mid)).toFixed(2)}px`,
                                        animationDelay: `${index * 45}ms`,
                                    } as CSSProperties
                                }
                                tabIndex={0}
                                aria-label={`${index + 1} ${layer.label}${state ? `, ${state}` : ''}`}
                                onMouseEnter={() => setFocus(layer.id)}
                                onFocus={() => setFocus(layer.id)}
                                onBlur={() => setFocus(null)}
                            >
                                <path className="audit-cycle-shape" d={segmentPath(index)} />
                                <text className="audit-cycle-no" x={label.x} y={label.y - 7} textAnchor="middle">
                                    {index + 1}
                                </text>
                                <text className="audit-cycle-label" x={label.x} y={label.y + 9} textAnchor="middle">
                                    {layer.label}
                                </text>
                            </g>
                        );
                    })}
                    {/* 가운데: 이 기록의 층 */}
                    {here ? (
                        <g className="audit-cycle-center" aria-hidden="true">
                            <text x={C} y={C - 8} textAnchor="middle" className="audit-cycle-kicker">
                                이 기록
                            </text>
                            <text x={C} y={C + 17} textAnchor="middle" className="audit-cycle-name">
                                {here.label}
                            </text>
                        </g>
                    ) : null}
                </svg>

                {/* 설명 칸 (aria-live: 층을 옮겨 짚으면 화면 읽기 프로그램이 새 설명을 읽는다) */}
                {shown ? (
                    <div className="audit-cycle-panel" aria-live="polite">
                        <div className="audit-cycle-panel-head">
                            <span className={`audit-cycle-panel-no${showingHere ? ' is-here' : marks[shown.id] ? ' is-marked' : ''}`}>
                                {shownIndex + 1}
                            </span>
                            <strong>{shown.label}</strong>
                            {showingHere ? (
                                <span className="audit-cycle-tag">이 기록</span>
                            ) : marks[shown.id] ? (
                                <span className="audit-cycle-tag is-marked">흔적</span>
                            ) : null}
                        </div>
                        <p className="audit-cycle-panel-text">{showingHere ? hereText(record) : shown.description}</p>
                        {marks[shown.id] ? <p className="audit-cycle-panel-mark">{marks[shown.id]}</p> : null}
                        {showingHere ? (
                            otherMarks.length ? (
                                <div className="audit-cycle-traces">
                                    <span className="audit-cycle-traces-title">다른 층에 남긴 흔적</span>
                                    <ul>
                                        {otherMarks.map((layer) => (
                                            <li key={layer.id}>
                                                <strong>
                                                    {LAYERS.indexOf(layer) + 1} {layer.label}
                                                </strong>
                                                <span>{marks[layer.id]}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ) : null
                        ) : (
                            <p className="audit-cycle-panel-note">{RECORDED_TEXT[shown.recorded]}</p>
                        )}
                        <p className="audit-cycle-hint">
                            {focus ? '마우스를 떼거나 다른 곳을 누르면 이 기록으로 돌아갑니다' : '층을 짚으면 그 층의 설명이 나옵니다 · 1 효과부터 역추적에서 따져 보는 차례'}
                        </p>
                    </div>
                ) : null}
            </div>
        </section>
    );
}
