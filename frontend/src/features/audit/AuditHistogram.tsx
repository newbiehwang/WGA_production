// 감사 로그 목록 위의 시간대별 건수 막대그래프 (Datadog Audit Trail의 막대그래프를 따랐다).
//   ■ 성공 1,650  ■ 실패 150                                  드래그해 기간 좁히기
//   50 ┤        ▂       ▅
//      │ ▁ ▂ ▅ ▃█ ▁ ▁ ▇ █ ▂       ← 칸마다 실패(아래)·성공(위)을 쌓는다. 실패를 바닥에 두어 칸끼리 비교하기 쉽게
//      └─────────────────────
//       09:00   12:00   15:00
//
// - 목록과 같은 기록(기간·거르기를 적용한 것)을 센다. 칸의 크기는 기간을 60칸 이하로 나누는 가장 작은 것 (timeWindow.ts)
// - 마우스를 올리면 그 칸의 시각과 건수를 보이고, 드래그하면 그 구간으로, 한 칸을 누르면 그 칸으로 기간을 좁힌다
// - 키보드: 그래프에 포커스를 두고 ←/→로 칸을 옮기고 Enter로 그 칸만 본다. 칸의 내용은 화면 읽기 프로그램에도 알린다
// - 색: 성공 #4a8fe0, 실패 #d03b3b (흰 바탕에서 색각 이상 구분·대비 검사를 통과한 값). 색만으로 구분하지 않게
//   범례와 말풍선에 이름을 함께 적는다
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { AuditRecord } from '@/types/audit';
import { timeOf } from './auditModel';
import { bucketSizeOf, bucketStart, formatShort, formatTick, type TimeWindow } from './timeWindow';

const COLORS = { ok: '#4a8fe0', error: '#d03b3b' };
const PLOT_H = 64; // 막대가 서는 높이
const TOP = 6; // 위쪽 눈금 글자 자리
const AXIS_H = 18; // 아래 눈금 글자 자리
const GUTTER = 30; // 왼쪽 세로 눈금 글자 자리
const GAP = 2; // 막대 사이·쌓은 조각 사이의 틈 (바탕색)
const MAX_BAR = 24;
const RADIUS = 4;

interface Bucket {
    start: number;
    ok: number;
    error: number;
}

const failedOf = (record: AuditRecord) => record.status === 'error' || record.event === 'failed';

// 0부터 max를 덮는 깔끔한 윗값 (1·2·5 × 10^k)
const niceMax = (max: number) => {
    if (max <= 1) return 1;
    const power = 10 ** Math.floor(Math.log10(max));
    return [1, 2, 5, 10].map((step) => step * power).find((value) => value >= max) ?? max;
};

// 위쪽 두 모서리만 둥근 막대 (바닥은 각지게)
const barPath = (x: number, y: number, w: number, h: number, rounded: boolean) => {
    const r = rounded ? Math.min(RADIUS, w / 2, h) : 0;
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

export function AuditHistogram({
    records,
    window,
    onSelect,
}: {
    records: AuditRecord[];
    window: TimeWindow;
    onSelect: (window: TimeWindow) => void;
}) {
    const wrap = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    const [active, setActive] = useState<number | null>(null); // 마우스·키보드로 가리킨 칸
    const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);

    useLayoutEffect(() => {
        const node = wrap.current;
        if (!node) return;
        const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    const size = bucketSizeOf(window);
    const buckets = useMemo(() => {
        const first = bucketStart(window.from, size);
        const count = Math.max(1, Math.ceil((window.to - first) / size));
        const list: Bucket[] = Array.from({ length: count }, (_, index) => ({ start: first + index * size, ok: 0, error: 0 }));
        for (const record of records) {
            const index = Math.floor((Date.parse(timeOf(record)) - first) / size);
            const bucket = list[index];
            if (!bucket) continue;
            if (failedOf(record)) bucket.error += 1;
            else bucket.ok += 1;
        }
        return list;
    }, [records, window.from, window.to, size]);

    const totals = useMemo(
        () => buckets.reduce((sum, b) => ({ ok: sum.ok + b.ok, error: sum.error + b.error }), { ok: 0, error: 0 }),
        [buckets],
    );
    const top = niceMax(Math.max(...buckets.map((b) => b.ok + b.error)));

    const plotW = Math.max(0, width - GUTTER);
    const slot = plotW / buckets.length;
    const barW = Math.max(1, Math.min(MAX_BAR, slot - GAP));
    const xOf = (index: number) => GUTTER + index * slot + (slot - barW) / 2;
    const hOf = (value: number) => (value / top) * PLOT_H;
    const indexAt = (x: number) => Math.min(buckets.length - 1, Math.max(0, Math.floor((x - GUTTER) / slot)));
    const baseY = TOP + PLOT_H;

    // 눈금: 글자가 겹치지 않게 약 80px마다 한 칸
    const tickEvery = Math.max(1, Math.ceil(80 / Math.max(slot, 1)));

    // 칸 하나 또는 여러 칸을 기간으로 (전체 기간 밖으로 나가지 않게)
    const selectBuckets = (from: number, to: number) =>
        onSelect({
            from: Math.max(window.from, buckets[from].start),
            to: Math.min(window.to, buckets[to].start + size),
        });

    const pointerX = (event: PointerEvent<SVGSVGElement>) => event.clientX - event.currentTarget.getBoundingClientRect().left;

    const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
        if (event.button !== 0) return;
        event.preventDefault(); // 마우스로 누를 때는 포커스(테두리)를 옮기지 않는다. 키보드로 왔을 때만 테두리가 보인다
        event.currentTarget.setPointerCapture(event.pointerId);
        const x = pointerX(event);
        setDrag({ x0: x, x1: x });
    };
    const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
        const x = pointerX(event);
        if (drag) setDrag({ ...drag, x1: x });
        setActive(indexAt(x));
    };
    const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
        if (!drag) return;
        const x = pointerX(event);
        const [a, b] = [Math.min(drag.x0, x), Math.max(drag.x0, x)];
        setDrag(null);
        if (b - a > 4) selectBuckets(indexAt(a), indexAt(b)); // 드래그: 그 구간
        else selectBuckets(indexAt(x), indexAt(x)); // 누르기: 그 칸
    };

    const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
        const current = active ?? buckets.length - 1;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            setActive(Math.min(buckets.length - 1, Math.max(0, current + (event.key === 'ArrowLeft' ? -1 : 1))));
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            setActive(event.key === 'Home' ? 0 : buckets.length - 1);
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectBuckets(current, current);
        }
    };
    // 키보드로 들어오면 기록이 있는 마지막 칸부터
    const onFocus = () => {
        if (active !== null) return;
        const last = buckets.map((b) => b.ok + b.error > 0).lastIndexOf(true);
        setActive(last >= 0 ? last : buckets.length - 1);
    };

    const shown = active !== null ? buckets[active] : null;
    const rangeText = (bucket: Bucket) => `${formatShort(bucket.start)} ~ ${formatShort(bucket.start + size)}`;
    const tooltipLeft = active !== null ? Math.min(Math.max(xOf(active) + barW / 2, 90), Math.max(90, width - 90)) : 0;

    return (
        <div className="audit-histogram">
            <div className="audit-histogram-legend">
                <span>
                    <svg width="10" height="10" aria-hidden="true">
                        <rect width="10" height="10" rx="2" fill={COLORS.ok} />
                    </svg>
                    성공 <strong>{totals.ok.toLocaleString()}</strong>
                </span>
                <span>
                    <svg width="10" height="10" aria-hidden="true">
                        <rect width="10" height="10" rx="2" fill={COLORS.error} />
                    </svg>
                    실패 <strong>{totals.error.toLocaleString()}</strong>
                </span>
                <span className="audit-histogram-hint">드래그하거나 막대를 눌러 기간 좁히기</span>
            </div>
            <div ref={wrap} className="audit-histogram-plot">
                {width > 0 ? (
                    <svg
                        width={width}
                        height={TOP + PLOT_H + AXIS_H}
                        tabIndex={0}
                        role="group"
                        aria-label="시간대별 기록 건수. ←/→로 시간대를 옮기고 Enter로 그 시간대만 봅니다"
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerLeave={() => !drag && setActive(null)}
                        onKeyDown={onKeyDown}
                        onFocus={onFocus}
                        onBlur={() => setActive(null)}
                    >
                        {/* 세로 눈금: 윗값과 바닥 (가는 선) */}
                        <line x1={GUTTER} x2={width} y1={TOP} y2={TOP} className="audit-histogram-grid" />
                        <line x1={GUTTER} x2={width} y1={baseY} y2={baseY} className="audit-histogram-axis" />
                        <text x={GUTTER - 6} y={TOP + 4} textAnchor="end" className="audit-histogram-tick">
                            {top.toLocaleString()}
                        </text>
                        <text x={GUTTER - 6} y={baseY} textAnchor="end" className="audit-histogram-tick">
                            0
                        </text>

                        {/* 가리킨 칸의 옅은 바탕 */}
                        {active !== null ? (
                            <rect
                                x={GUTTER + active * slot}
                                y={TOP}
                                width={slot}
                                height={PLOT_H}
                                className="audit-histogram-hover"
                            />
                        ) : null}

                        {buckets.map((bucket, index) => {
                            const x = xOf(index);
                            const errorH = hOf(bucket.error);
                            const okH = hOf(bucket.ok);
                            // 두 조각이 다 있으면 사이에 틈을 둔다. 맨 위 조각만 위 모서리가 둥글다
                            const gap = bucket.error && bucket.ok ? GAP : 0;
                            return (
                                <g key={bucket.start}>
                                    {bucket.error ? (
                                        <path
                                            d={barPath(x, baseY - errorH, barW, errorH, !bucket.ok)}
                                            fill={COLORS.error}
                                        />
                                    ) : null}
                                    {bucket.ok ? (
                                        <path
                                            d={barPath(x, baseY - errorH - gap - okH, barW, okH, true)}
                                            fill={COLORS.ok}
                                        />
                                    ) : null}
                                </g>
                            );
                        })}

                        {/* 오른쪽 끝에 걸려 잘릴 눈금은 그리지 않는다 */}
                        {buckets.map((bucket, index) =>
                            index % tickEvery === 0 && GUTTER + index * slot + 36 <= width ? (
                                <text
                                    key={`t${bucket.start}`}
                                    x={GUTTER + index * slot}
                                    y={baseY + 14}
                                    className="audit-histogram-tick"
                                >
                                    {formatTick(bucket.start, size)}
                                </text>
                            ) : null,
                        )}

                        {/* 드래그 중인 구간 */}
                        {drag ? (
                            <rect
                                x={Math.min(drag.x0, drag.x1)}
                                y={TOP}
                                width={Math.abs(drag.x1 - drag.x0)}
                                height={PLOT_H}
                                className="audit-histogram-brush"
                            />
                        ) : null}
                    </svg>
                ) : null}

                {shown && !drag ? (
                    <div className="audit-histogram-tooltip" style={{ left: tooltipLeft }} aria-hidden="true">
                        <div className="audit-histogram-tooltip-time">{rangeText(shown)}</div>
                        <div>
                            <i style={{ background: COLORS.ok }} />
                            <strong>{shown.ok.toLocaleString()}</strong> 성공
                        </div>
                        <div>
                            <i style={{ background: COLORS.error }} />
                            <strong>{shown.error.toLocaleString()}</strong> 실패
                        </div>
                    </div>
                ) : null}
                {/* 화면 읽기 프로그램: 가리킨 칸의 내용 */}
                <span className="sr-only" aria-live="polite">
                    {shown ? `${rangeText(shown)}: 성공 ${shown.ok}건, 실패 ${shown.error}건` : ''}
                </span>
            </div>
        </div>
    );
}
