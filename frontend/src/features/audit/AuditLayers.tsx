// 층 다이어그램: 7계층을 원 위에 놓고 화살표로 한 바퀴 잇는다 (루프). 도구 호출·변경 작업 행의 팝업창 맨 위에 보인다
// (질문·사용자 관리 행에는 층이 없다).
//
//                 ① 효과
//        ⑦ 매개 ╭───────╮ ② 유출 ●      ← 이 기록의 층: 파랑으로 채운 원
//      ⑥ 경계  │  이 기록  │  ③ 체류 ●    ← 흔적: 주황으로 채운 원
//        ⑤ 유입 ╰── ② 유출 ─╯ ④ 판단 ┄    ← 기록으로 남지 않는 층(판단·매개): 점선 원
//   ▶ 유출 · 승인 요청을 만들었습니다. 아직 AWS는 바뀌지 않았습니다
//   ● 체류 · 의심 문구가 든 결과를 읽은 뒤 요청한 변경입니다 (1건)
//
// - 번호와 화살표의 차례는 역추적('층별로 따져 보기', services/llm/audit_trace.py)이 묻는 차례다 (① 효과부터)
// - 이 기록의 층: 행의 locus (도구 반복이 정한다: 등록부에 없으면 경계, 변경 도구면 유출, 나머지는 유입.
//   변경 작업은 요청이 유출, 결정·실행이 효과)
// - 흔적: 체류(승인 요청 행의 taintedBy), 유입(도구 행의 의심 문구), 매개(실행한 AWS API의 요청 ID)
// - 원 가운데에는 이 기록의 층 이름만, 이 기록이 한 일과 흔적은 원 아래 줄로 (가운데는 좁아 긴 문장이 들어가지 않는다)
// - 층에 마우스를 올리면 그 층의 설명이 뜬다 (<title>). 화면 읽기 프로그램에는 그림 대신 같은 내용을 목록으로 준다
// - 폭이 좁으면(팝업창이 좁은 화면) 가로로 긴 타원 대신 원으로 그려 글자가 작아지지 않게 한다
import { useLayoutEffect, useRef, useState } from 'react';
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

// 그림의 틀: 넓으면 가로로 긴 타원, 좁으면 원
const WIDE = { width: 600, height: 244, rx: 206, ry: 90 };
const NARROW = { width: 340, height: 296, rx: 104, ry: 104 };
const NARROW_BELOW = 480; // 담는 상자의 폭(px)이 이보다 좁으면 원으로
const NODE_R = 15;

type Frame = typeof WIDE;

// 층 i의 자리: 맨 위(① 효과)에서 시작해 시계 방향으로 7등분
const angleOf = (index: number) => -Math.PI / 2 + (index * 2 * Math.PI) / LAYERS.length;
const pointOf = (frame: Frame, angle: number) => ({
    x: frame.width / 2 + frame.rx * Math.cos(angle),
    y: frame.height / 2 + frame.ry * Math.sin(angle),
});

// 층 이름의 자리: 원 바깥쪽. 위·아래 끝은 가운데 맞춤, 오른쪽은 왼쪽 맞춤, 왼쪽은 오른쪽 맞춤
function labelOf(frame: Frame, angle: number) {
    const { x, y } = pointOf(frame, angle);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    if (Math.abs(cos) < 0.2) return { x, y: y + (sin < 0 ? -NODE_R - 8 : NODE_R + 17), anchor: 'middle' as const };
    return { x: x + (cos > 0 ? NODE_R + 7 : -NODE_R - 7), y: y + 4.5, anchor: cos > 0 ? ('start' as const) : ('end' as const) };
}

// 층 i에서 i+1로 가는 화살촉: 두 층 사이 가운데에서 타원을 따라 시계 방향을 가리킨다
function arrowOf(frame: Frame, index: number) {
    const angle = angleOf(index) + Math.PI / LAYERS.length;
    const { x, y } = pointOf(frame, angle);
    // 타원 위 점의 접선 (각이 커지는 쪽 = 화면에서 시계 방향)
    const rotate = (Math.atan2(frame.ry * Math.cos(angle), -frame.rx * Math.sin(angle)) * 180) / Math.PI;
    return { x, y, rotate };
}

// 담는 상자의 폭으로 틀을 고른다
function useFrame() {
    const box = useRef<HTMLDivElement>(null);
    const [narrow, setNarrow] = useState(false);
    useLayoutEffect(() => {
        const element = box.current;
        if (!element) return;
        const measure = () => setNarrow(element.getBoundingClientRect().width < NARROW_BELOW);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return { box, frame: narrow ? NARROW : WIDE };
}

export function AuditLayers({ record }: { record: AuditRecord }) {
    const { box, frame } = useFrame();
    const marks = marksOf(record);
    const hereIndex = LAYERS.findIndex((layer) => layer.id === record.locus);
    const here = LAYERS[hereIndex];
    const markedLayers = LAYERS.filter((layer) => marks[layer.id] && layer.id !== record.locus);

    return (
        <section className="audit-layers" aria-labelledby="audit-layers-title">
            <h4 id="audit-layers-title" className="audit-layers-title">
                층 <span className="audit-muted">7계층에서 이 기록의 자리</span>
            </h4>

            <div ref={box} className="audit-loop">
                <svg
                    className="audit-loop-svg"
                    viewBox={`0 0 ${frame.width} ${frame.height}`}
                    role="img"
                    aria-labelledby="audit-loop-summary"
                >
                    {/* 루프: 타원 하나와 층 사이의 화살촉 */}
                    <ellipse
                        className="audit-loop-track"
                        cx={frame.width / 2}
                        cy={frame.height / 2}
                        rx={frame.rx}
                        ry={frame.ry}
                    />
                    {LAYERS.map((layer, index) => {
                        const arrow = arrowOf(frame, index);
                        return (
                            <path
                                key={`arrow-${layer.id}`}
                                className="audit-loop-arrow"
                                d="M -4 -4.5 L 4 0 L -4 4.5 Z"
                                transform={`translate(${arrow.x} ${arrow.y}) rotate(${arrow.rotate})`}
                            />
                        );
                    })}

                    {LAYERS.map((layer, index) => {
                        const angle = angleOf(index);
                        const { x, y } = pointOf(frame, angle);
                        const label = labelOf(frame, angle);
                        const isHere = index === hereIndex;
                        const isMarked = !isHere && Boolean(marks[layer.id]);
                        const offRecord = layer.recorded === 'none' || layer.recorded === 'outside';
                        return (
                            <g
                                key={layer.id}
                                className={`audit-loop-node${isHere ? ' is-here' : isMarked ? ' is-marked' : ''}${
                                    offRecord ? ' is-off-record' : ''
                                }`}
                                style={{ animationDelay: `${index * 40}ms` }}
                            >
                                <title>{`${index + 1} ${layer.label}: ${layer.description}`}</title>
                                {isHere ? <circle className="audit-loop-halo" cx={x} cy={y} r={NODE_R + 7} /> : null}
                                <circle className="audit-loop-dot" cx={x} cy={y} r={NODE_R} />
                                <text className="audit-loop-no" x={x} y={y + 4.5} textAnchor="middle">
                                    {index + 1}
                                </text>
                                <text className="audit-loop-label" x={label.x} y={label.y} textAnchor={label.anchor}>
                                    {layer.label}
                                </text>
                            </g>
                        );
                    })}
                </svg>

                {/* 가운데: 이 기록의 층 */}
                {here ? (
                    <div className="audit-loop-center" aria-hidden="true">
                        <span className="audit-loop-center-kicker">이 기록</span>
                        <span className="audit-loop-center-name">
                            {hereIndex + 1} {here.label}
                        </span>
                    </div>
                ) : null}
            </div>

            {/* 이 기록이 한 일과 흔적 (그림의 뜻을 글로도: 화면 읽기 프로그램은 이 요약을 그림의 이름으로 읽는다) */}
            <ul id="audit-loop-summary" className="audit-loop-notes">
                {here ? (
                    <li className="is-here">
                        <strong>
                            {hereIndex + 1} {here.label}
                        </strong>
                        <span>{hereText(record)}</span>
                        {marks[here.id] ? <span className="audit-loop-note-mark">{marks[here.id]}</span> : null}
                    </li>
                ) : null}
                {markedLayers.map((layer) => (
                    <li key={layer.id} className="is-marked">
                        <strong>
                            {LAYERS.indexOf(layer) + 1} {layer.label}
                        </strong>
                        <span>{marks[layer.id]}</span>
                    </li>
                ))}
            </ul>

            {/* 범례: 점과 글을 한 덩어리로 (좁은 화면에서 줄이 바뀌어도 떨어지지 않게) */}
            <ul className="audit-layers-legend">
                <li>
                    <span className="audit-legend-dot is-here" aria-hidden="true" />이 기록
                </li>
                <li>
                    <span className="audit-legend-dot is-marked" aria-hidden="true" />흔적
                </li>
                <li>
                    <span className="audit-legend-dot is-off-record" aria-hidden="true" />
                    기록으로 남지 않는 층 (판단: 모델 안, 매개: 앱 밖의 AWS 기록)
                </li>
                <li>화살표: 역추적에서 따져 보는 차례</li>
            </ul>
        </section>
    );
}
