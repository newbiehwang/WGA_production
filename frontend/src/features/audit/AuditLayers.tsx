// 층 다이어그램: 7계층을 고리 모양의 순환 다이어그램으로 그린다. 도구 호출·변경 작업 행의 팝업창 맨 위에 보인다
// (질문·사용자 관리 행에는 층이 없다).
//
//   7계층 위치
//        ╭ 효과 ╮                     [5] 유입 Ingress
//     매개      유출 ▸               비용 조회의 결과가 모델에게 들어갔습니다
//    경계   유입    체류              ┌ 다른 계층에 남긴 흔적 ───────────────┐
//     ▸[유입]    판단                │ 3 체류  의심 문구가 든 결과를 읽은 뒤 … │
//        ╰────╯                      └──────────────────────────────┘
//
// - 고리는 조각 7개다. 조각 끝이 뾰족해(셰브런) 따로 화살표 없이 도는 방향이 보인다.
//   차례는 역추적('층별로 따져 보기', services/llm/audit_trace.py)이 묻는 차례다 (맨 위 1 효과부터 시계 방향)
// - 색은 계층의 성격: 이 기록의 계층(행의 locus)은 파랑, 흔적이 있는 계층은 옅은 주황,
//   기록으로 남지 않는 계층(판단: 모델 안, 매개: 앱 밖)은 점선 테두리. 색은 고르는 것과 상관없이 그대로다
// - 고른 계층(처음에는 이 기록의 계층): 고리 바깥의 선택 표시(둥근 호)가 그 조각 위로 미끄러져 가고(가까운 쪽으로 돈다),
//   조각은 그림자와 함께 살짝 떠오르며, 나머지 조각은 은은하게 옅어진다. 선택 표시의 색은 그 계층의 성격을 따른다.
//   마우스를 올리거나 고른 조각은 바탕이 조금 짙어진다. 고리 가운데(옅은 원판 위에 차례 '2 / 7'과 이름)와 오른쪽 설명 칸도 고른 계층을 보인다. 색(성격)과 고름(표시·떠오름)을 나눠야
//   다른 계층을 골랐을 때 이 기록의 계층과 헷갈리지 않는다
// - 조각을 누르면(키보드는 Enter·Space) 그 계층을 고르고, 고른 조각을 다시 누르면 이 기록의 계층으로 돌아온다
// - 설명 칸: 계층의 설명 → 이 기록이 그 계층에서 한 일(파란 상자) → 그 계층의 흔적(주황 상자).
//   이 기록의 계층을 고르고 있으면 다른 계층에 남긴 흔적도 모아 보인다. 제목 옆에는 영어 이름을 회색으로 (고리 안은 한글만)
// - 이 기록의 층: 도구 반복이 정한다 (등록부에 없으면 경계, 변경 도구면 유출, 나머지는 유입. 변경 작업은 요청이 유출, 결정·실행이 효과)
// - 흔적: 체류(승인 요청 행의 taintedBy), 유입(도구 행의 의심 문구), 매개(실행한 AWS API의 요청 ID)
import { useEffect, useState, type CSSProperties } from 'react';
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

// ---------------------------------------------------------------- 고리의 모양
const SIZE = 240;
const C = SIZE / 2; // 가운데
const R_OUT = 112; // 바깥 반지름
const R_IN = 72; // 안쪽 반지름
const R_MID = (R_OUT + R_IN) / 2;
const SPAN = 360 / LAYERS.length; // 조각 하나의 각 (도)
const GAP = 2.2; // 조각 사이 틈 (도)
const TIP = 5; // 셰브런의 뾰족한 끝이 나아가는 각 (도)
const POP = 4; // 고른 조각을 바깥으로 띄우는 거리

const rad = (deg: number) => (deg * Math.PI) / 180;
const at = (r: number, deg: number) => `${(C + r * Math.cos(rad(deg))).toFixed(2)} ${(C + r * Math.sin(rad(deg))).toFixed(2)}`;
const R_MARK = R_OUT + POP + 7; // 선택 표시(호)의 반지름
const MARK_INSET = 5; // 선택 표시가 조각보다 양끝에서 짧은 각 (도)
const PAD = R_MARK - R_OUT + 6; // 그림 둘레의 여백 (선택 표시와 그림자가 잘리지 않게)

// 선택 표시: 맨 위 조각(0번) 자리의 호. 고른 조각으로 돌려서(rotate) 옮긴다 (가운데가 원점인 좌표)
const MARK_PATH = (() => {
    // 조각의 양끝에서 MARK_INSET만큼 줄이고, 셰브런 끝만큼(TIP / 2) 앞으로 치우친 조각의 가운데에 맞춘다
    const a0 = -90 - SPAN / 2 + GAP / 2 + MARK_INSET + TIP / 2;
    const a1 = -90 + SPAN / 2 - GAP / 2 - MARK_INSET + TIP / 2;
    const p = (deg: number) => `${(R_MARK * Math.cos(rad(deg))).toFixed(2)} ${(R_MARK * Math.sin(rad(deg))).toFixed(2)}`;
    return `M ${p(a0)} A ${R_MARK} ${R_MARK} 0 0 1 ${p(a1)}`;
})();

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
    const hereIndex = LAYERS.findIndex((layer) => layer.id === record.locus);
    const here = LAYERS[hereIndex];
    // 고른 계층: 누른 조각, 누르기 전에는 이 기록의 계층
    const [picked, setPicked] = useState<TraceLayer | null>(null);
    const marks = marksOf(record);
    const selectedIndex = picked ? LAYERS.findIndex((layer) => layer.id === picked) : hereIndex;
    const selected = LAYERS[selectedIndex];
    const selectedIsHere = selectedIndex === hereIndex;
    const otherMarks = LAYERS.filter((layer) => marks[layer.id] && layer.id !== here?.id);
    // 계층의 성격 (색): 이 기록 · 흔적 · 기록으로 남지 않음
    const toneOf = (index: number) =>
        index === hereIndex ? 'is-here' : marks[LAYERS[index].id] ? 'is-marked' : '';

    // 선택 표시의 회전각. 고른 조각이 바뀌면 가까운 쪽으로 돈다 (7 → 1은 한 칸 앞으로, 거꾸로 여섯 칸 돌지 않게)
    const [turn, setTurn] = useState(selectedIndex * SPAN);
    useEffect(() => {
        const target = selectedIndex * SPAN;
        setTurn((previous) => previous + ((((target - previous) % 360) + 540) % 360) - 180);
    }, [selectedIndex]);

    return (
        <section className="audit-layers" aria-labelledby="audit-layers-title">
            <h4 id="audit-layers-title" className="audit-layers-title">
                7계층 위치
            </h4>

            <div className="audit-cycle">
                <svg
                    className={`audit-cycle-svg${picked ? ' has-pick' : ''}`}
                    viewBox={`${-PAD} ${-PAD} ${SIZE + PAD * 2} ${SIZE + PAD * 2}`}
                    role="group"
                    aria-label="7계층 순환 다이어그램. 계층을 누르면 설명이 나옵니다"
                >
                    {LAYERS.map((layer, index) => {
                        const tone = toneOf(index);
                        const offRecord = layer.recorded === 'none' || layer.recorded === 'outside';
                        const isSelected = index === selectedIndex;
                        const mid = rad(midOf(index));
                        const label = labelAt(index);
                        const state =
                            tone === 'is-here' ? '이 기록의 계층' : tone === 'is-marked' ? '흔적' : offRecord ? '기록으로 남지 않음' : '';
                        // 누르면 그 계층을 고르고, 고른 조각을 다시 누르면 이 기록의 계층으로 돌아온다
                        const choose = () => setPicked(isSelected || index === hereIndex ? null : layer.id);
                        return (
                            <g
                                key={layer.id}
                                className={`audit-cycle-seg ${tone}${offRecord ? ' is-off-record' : ''}${
                                    isSelected ? ' is-selected' : ''
                                }`}
                                // 고른 조각은 가운데에서 바깥으로 밀어낸다 (--dx·--dy: CSS가 transform으로)
                                style={
                                    {
                                        '--dx': `${(POP * Math.cos(mid)).toFixed(2)}px`,
                                        '--dy': `${(POP * Math.sin(mid)).toFixed(2)}px`,
                                        animationDelay: `${index * 45}ms`,
                                    } as CSSProperties
                                }
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
                                <text className="audit-cycle-no" x={label.x} y={label.y - 7} textAnchor="middle">
                                    {index + 1}
                                </text>
                                <text className="audit-cycle-label" x={label.x} y={label.y + 9} textAnchor="middle">
                                    {layer.label}
                                </text>
                            </g>
                        );
                    })}
                    {/* 선택 표시: 고리 바깥의 둥근 호. 가운데로 옮긴 뒤 돌린다 (CSS transition으로 미끄러진다) */}
                    {selected ? (
                        <g transform={`translate(${C} ${C})`} aria-hidden="true">
                            <path
                                className={`audit-cycle-mark ${toneOf(selectedIndex)}`}
                                d={MARK_PATH}
                                style={{ transform: `rotate(${turn}deg)` }}
                            />
                        </g>
                    ) : null}
                    {/* 가운데: 옅은 원판 위에 고른 계층의 차례(작은 회색)와 이름(색은 그 계층의 성격). 고르면 바뀌며 살짝 떠오른다 */}
                    <circle className="audit-cycle-hub" cx={C} cy={C} r={R_IN - 9} aria-hidden="true" />
                    {selected ? (
                        <g key={selected.id} className={`audit-cycle-center ${toneOf(selectedIndex)}`} aria-hidden="true">
                            <text x={C} y={C - 9} textAnchor="middle" className="audit-cycle-step">
                                {selectedIndex + 1} / {LAYERS.length}
                            </text>
                            <text x={C} y={C + 15} textAnchor="middle" className="audit-cycle-name">
                                {selected.label}
                            </text>
                        </g>
                    ) : null}
                </svg>

                {/* 설명 칸 (aria-live: 다른 계층을 고르면 화면 읽기 프로그램이 새 설명을 읽는다) */}
                {selected ? (
                    <div className="audit-cycle-panel" aria-live="polite" key={selected.id}>
                        <div className="audit-cycle-panel-head">
                            <span className={`audit-cycle-panel-no ${toneOf(selectedIndex)}`}>{selectedIndex + 1}</span>
                            <strong>{selected.label}</strong>
                            <span className="audit-cycle-en">{selected.en}</span>
                        </div>
                        <p className="audit-cycle-panel-text">{selected.description}</p>
                        {selectedIsHere ? <p className="audit-cycle-callout is-here">{hereText(record)}</p> : null}
                        {marks[selected.id] ? <p className="audit-cycle-callout is-marked">{marks[selected.id]}</p> : null}
                        {selectedIsHere && otherMarks.length ? (
                            <div className="audit-cycle-traces">
                                <span className="audit-cycle-traces-title">다른 계층에 남긴 흔적</span>
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
                        ) : null}
                    </div>
                ) : null}
            </div>
        </section>
    );
}
