// 감사 로그 목록 위의 시간대별 건수 막대그래프 (Datadog Audit Trail의 막대그래프를 따랐다).
//   ■ 성공 471  ■ 실패 43                                     드래그하거나 막대를 눌러 기간 좁히기
//   30 ┤─────────────────────────────────          ← 가는 가로 눈금선 (0 · 중간 · 윗값)
//   20 ┤──────────────▅──────────────────
//   10 ┤──▂──▅─▃█──▁─▁█─▇─█─▂──────────────
//    0 ┴──█──█─██──█─██─█─█─█───────────
//        9/24     06:00     12:00     18:00    9/25      ← 날이 바뀌는 눈금은 날짜(굵게), 나머지는 시각
//
// - 목록과 같은 기록(기간·검색어·거르기를 적용한 것)을 칸마다 센다. 칸은 기간에 따라 1분~하루 (timeWindow.bucketSizeOf)
// - 칸마다 실패(아래)·성공(위)을 쌓는다. 실패를 바닥에 두어 칸끼리 실패 건수를 비교하기 쉽게
// - 가로 눈금은 막대 수와 상관없이 '보기 좋은 시각'에 찍는다 (10분·3시간·하루·5일 등, timeWindow.ticksOf)
// - 기록이 없으면 그래프 자리에 '이 기간에 기록이 없습니다'. 불러오는 동안에는 앞 그래프를 흐리게 남겨 둔다
// - 마우스를 올리면 그 칸의 시각과 건수를 막대 옆 말풍선으로 보인다 (그래프 안에 두어 위의 버튼을 가리지 않게)
// - 드래그하면 그 구간으로, 한 칸을 누르면 그 칸으로 기간을 좁힌다. 드래그하는 동안 고른 구간의 시각을 위에 보인다
//   (좁힌 뒤 돌아가는 '이전 기간'은 AuditPage가 쌓아 둔다)
// - 목록의 행에 마우스를 올리면(highlightAt) 그 기록이 든 칸을 옅게 칠하고 바닥선 바로 아래에 파란 줄을 긋는다
// - 키보드: 그래프에 포커스를 두고 ←/→로 칸을 옮기고 Enter로 그 칸만 본다. 칸의 내용은 화면 읽기 프로그램에도 알린다
// - 색: 성공 #4a8fe0, 실패 #d03b3b (흰 바탕에서 색각 이상 구분·대비 검사를 통과한 값). 색만으로 구분하지 않게
//   범례와 말풍선에 이름을 함께 적는다
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { AuditRecord } from '@/types/audit';
import { timeOf } from './auditModel';
import { bucketSizeOf, bucketStart, formatShort, ticksOf, type TimeWindow } from './timeWindow';

// 쌓는 계열 (아래부터). 나눠 보기를 더하면 이 목록이 바뀐다
interface Series {
    key: string;
    label: string;
    color: string;
}
const RESULT_SERIES: Series[] = [
    { key: 'error', label: '실패', color: '#d03b3b' },
    { key: 'ok', label: '성공', color: '#4a8fe0' },
];
const failedOf = (record: AuditRecord) => record.status === 'error' || record.event === 'failed';
const resultKeyOf = (record: AuditRecord) => (failedOf(record) ? 'error' : 'ok');

const PLOT_H = 140; // 막대가 서는 높이
const TOP = 8; // 윗값 글자가 잘리지 않게 둔 여백
const AXIS_H = 22; // 아래 눈금 글자 자리
const GUTTER = 40; // 왼쪽 세로 눈금 글자 자리
const GAP = 2; // 막대 사이·쌓은 조각 사이의 틈 (바탕색)
const MAX_BAR = 24;
const RADIUS = 4;

interface Bucket {
    start: number;
    counts: Record<string, number>;
    total: number;
}

// 세로 눈금: 0부터 max를 덮는 깔끔한 간격(1·2·5 × 10^k)으로 서너 개
const yTicksOf = (max: number) => {
    if (max <= 0) return { top: 1, ticks: [0] };
    const raw = max / 3;
    const power = 10 ** Math.floor(Math.log10(raw));
    const step = Math.max(1, [1, 2, 5, 10].map((m) => m * power).find((v) => v >= raw) ?? raw);
    const top = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    return { top, ticks };
};

// 위쪽 두 모서리만 둥근 막대 (바닥은 각지게)
const barPath = (x: number, y: number, w: number, h: number, rounded: boolean) => {
    const r = rounded ? Math.min(RADIUS, w / 2, h) : 0;
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

export function AuditHistogram({
    records,
    window,
    loading,
    highlightAt,
    onSelect,
}: {
    records: AuditRecord[];
    window: TimeWindow;
    loading: boolean; // 다시 불러오는 중: 앞 그래프를 흐리게 남겨 둔다
    highlightAt: number | null; // 목록에서 마우스를 올린 기록의 시각
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

    const series = RESULT_SERIES;
    const size = bucketSizeOf(window);
    const first = bucketStart(window.from, size);
    const buckets = useMemo(() => {
        const count = Math.max(1, Math.ceil((window.to - first) / size));
        const list: Bucket[] = Array.from({ length: count }, (_, index) => ({
            start: first + index * size,
            counts: {},
            total: 0,
        }));
        for (const record of records) {
            const bucket = list[Math.floor((Date.parse(timeOf(record)) - first) / size)];
            if (!bucket) continue;
            const key = resultKeyOf(record);
            bucket.counts[key] = (bucket.counts[key] ?? 0) + 1;
            bucket.total += 1;
        }
        return list;
    }, [records, first, window.to, size]);

    const totals = useMemo(() => {
        const sums: Record<string, number> = {};
        for (const bucket of buckets) for (const [key, n] of Object.entries(bucket.counts)) sums[key] = (sums[key] ?? 0) + n;
        return sums;
    }, [buckets]);
    const total = Object.values(totals).reduce((sum, n) => sum + n, 0);
    const { top, ticks: yTicks } = yTicksOf(Math.max(0, ...buckets.map((b) => b.total)));

    const plotW = Math.max(0, width - GUTTER);
    const end = first + buckets.length * size; // 마지막 칸의 끝
    const slot = plotW / buckets.length;
    const barW = Math.max(1, Math.min(MAX_BAR, slot - GAP));
    const xOfTime = (at: number) => GUTTER + ((at - first) / (end - first)) * plotW;
    const xOf = (index: number) => GUTTER + index * slot + (slot - barW) / 2;
    const yOf = (value: number) => TOP + PLOT_H - (value / top) * PLOT_H;
    const indexAt = (x: number) => Math.min(buckets.length - 1, Math.max(0, Math.floor((x - GUTTER) / slot)));
    const baseY = TOP + PLOT_H;
    const xTicks = useMemo(() => (plotW > 0 ? ticksOf(first, end, plotW) : []), [first, end, plotW]);

    // 칸 하나 또는 여러 칸을 기간으로 (전체 기간 밖으로 나가지 않게)
    const selectBuckets = (from: number, to: number) =>
        onSelect({
            from: Math.max(window.from, buckets[from].start),
            to: Math.min(window.to, buckets[to].start + size),
        });

    const pointerX = (event: PointerEvent<SVGSVGElement>) => event.clientX - event.currentTarget.getBoundingClientRect().left;
    const interactive = total > 0 && !loading;

    const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
        if (event.button !== 0 || !interactive) return;
        event.preventDefault(); // 마우스로 누를 때는 포커스(테두리)를 옮기지 않는다. 키보드로 왔을 때만 테두리가 보인다
        event.currentTarget.setPointerCapture(event.pointerId);
        const x = pointerX(event);
        setDrag({ x0: x, x1: x });
    };
    const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
        if (!interactive) return;
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
        if (!interactive) return;
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
        if (active !== null || !interactive) return;
        const last = buckets.map((b) => b.total > 0).lastIndexOf(true);
        setActive(last >= 0 ? last : buckets.length - 1);
    };

    const shown = active !== null && interactive ? buckets[active] : null;
    const rangeText = (bucket: Bucket) => `${formatShort(bucket.start)} ~ ${formatShort(bucket.start + size)}`;
    // 말풍선: 막대 오른쪽에 붙인다. 오른쪽 끝에 가까우면 왼쪽으로 뒤집는다
    const TOOLTIP_W = 180;
    const tooltipStyle =
        active !== null
            ? xOf(active) + barW + 10 + TOOLTIP_W <= width
                ? { left: xOf(active) + barW + 10, top: TOP + 4 }
                : { left: xOf(active) - 10, top: TOP + 4, transform: 'translateX(-100%)' }
            : undefined;

    // 드래그하는 동안: 고를 구간(칸 단위로 맞춘 것)의 시각
    const dragRange = drag
        ? (() => {
              const a = indexAt(Math.min(drag.x0, drag.x1));
              const b = indexAt(Math.max(drag.x0, drag.x1));
              return {
                  x: (Math.min(drag.x0, drag.x1) + Math.max(drag.x0, drag.x1)) / 2,
                  text: `${formatShort(Math.max(window.from, buckets[a].start))} ~ ${formatShort(
                      Math.min(window.to, buckets[b].start + size),
                  )}`,
              };
          })()
        : null;

    // 목록에서 가리킨 기록이 든 칸
    const marked =
        highlightAt !== null && total > 0 ? Math.floor((highlightAt - first) / size) : -1;
    const summary = (bucket: Bucket) =>
        `${rangeText(bucket)}: ${[...series].reverse().map((s) => `${s.label} ${bucket.counts[s.key] ?? 0}건`).join(', ')}`;

    return (
        <div className={`audit-histogram${loading ? ' is-loading' : ''}`}>
            <div className="audit-histogram-legend">
                {[...series].reverse().map((s) => (
                    <span key={s.key}>
                        <svg width="10" height="10" aria-hidden="true">
                            <rect width="10" height="10" rx="2" fill={s.color} />
                        </svg>
                        {s.label} <strong>{(totals[s.key] ?? 0).toLocaleString()}</strong>
                    </span>
                ))}
                {total > 0 ? <span className="audit-histogram-hint">드래그하거나 막대를 눌러 기간 좁히기</span> : null}
            </div>
            <div ref={wrap} className="audit-histogram-plot">
                {width > 0 ? (
                    <svg
                        width={width}
                        height={TOP + PLOT_H + AXIS_H}
                        tabIndex={interactive ? 0 : -1}
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
                        {/* 세로 눈금: 가는 가로선과 왼쪽 글자 (0은 바닥선) */}
                        {yTicks.map((value) => (
                            <g key={`y${value}`}>
                                <line
                                    x1={GUTTER}
                                    x2={width}
                                    y1={yOf(value)}
                                    y2={yOf(value)}
                                    className={value === 0 ? 'audit-histogram-axis' : 'audit-histogram-grid'}
                                />
                                {total > 0 || value === 0 ? (
                                    <text x={GUTTER - 8} y={yOf(value) + 4} textAnchor="end" className="audit-histogram-tick">
                                        {value.toLocaleString()}
                                    </text>
                                ) : null}
                            </g>
                        ))}

                        {/* 가로 눈금: 날짜(굵게)와 시각 */}
                        {xTicks.map((tick) => {
                            const x = xOfTime(tick.at);
                            if (x > width - 20) return null; // 오른쪽 끝에 걸려 잘릴 글자는 그리지 않는다
                            return (
                                <g key={`x${tick.at}`}>
                                    <line x1={x} x2={x} y1={baseY} y2={baseY + 4} className="audit-histogram-axis" />
                                    <text
                                        x={x}
                                        y={baseY + 17}
                                        textAnchor="middle"
                                        className={`audit-histogram-tick${tick.isDate ? ' is-date' : ''}`}
                                    >
                                        {tick.label}
                                    </text>
                                </g>
                            );
                        })}

                        {/* 목록에서 가리킨 기록이 든 칸: 옅은 바탕 + 바닥의 파란 줄 */}
                        {marked >= 0 && marked < buckets.length && !shown ? (
                            <g>
                                <rect x={GUTTER + marked * slot} y={TOP} width={slot} height={PLOT_H} className="audit-histogram-hover" />
                                <line
                                    x1={GUTTER + marked * slot + 1}
                                    x2={GUTTER + (marked + 1) * slot - 1}
                                    y1={baseY + 3}
                                    y2={baseY + 3}
                                    className="audit-histogram-mark"
                                />
                            </g>
                        ) : null}

                        {/* 가리킨 칸의 옅은 바탕 */}
                        {shown ? (
                            <rect
                                x={GUTTER + (active ?? 0) * slot}
                                y={TOP}
                                width={slot}
                                height={PLOT_H}
                                className="audit-histogram-hover"
                            />
                        ) : null}

                        {/* 막대: 계열을 아래부터 쌓는다. 조각 사이에 틈, 맨 위 조각만 위 모서리가 둥글다 */}
                        {buckets.map((bucket, index) => {
                            if (!bucket.total) return null;
                            const x = xOf(index);
                            const parts = series.filter((s) => bucket.counts[s.key]);
                            let y = baseY;
                            return (
                                <g key={bucket.start}>
                                    {parts.map((s, i) => {
                                        const h = ((bucket.counts[s.key] ?? 0) / top) * PLOT_H;
                                        const gap = i > 0 ? GAP : 0;
                                        const shape = barPath(x, y - gap - h, barW, h, i === parts.length - 1);
                                        y -= gap + h;
                                        return <path key={s.key} d={shape} fill={s.color} />;
                                    })}
                                </g>
                            );
                        })}

                        {/* 기록이 없으면 그래프 자리에 안내 (불러오는 중이면 비워 둔다) */}
                        {total === 0 && !loading ? (
                            <text x={GUTTER + plotW / 2} y={TOP + PLOT_H / 2} textAnchor="middle" className="audit-histogram-empty">
                                이 기간에 기록이 없습니다
                            </text>
                        ) : null}

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

                {dragRange ? (
                    <div className="audit-histogram-brush-label" style={{ left: dragRange.x }} aria-hidden="true">
                        {dragRange.text}
                    </div>
                ) : null}

                {shown && !drag ? (
                    <div className="audit-histogram-tooltip" style={tooltipStyle} aria-hidden="true">
                        <div className="audit-histogram-tooltip-time">{rangeText(shown)}</div>
                        {[...series].reverse().map((s) => (
                            <div key={s.key}>
                                <i style={{ background: s.color }} />
                                <strong>{(shown.counts[s.key] ?? 0).toLocaleString()}</strong> {s.label}
                            </div>
                        ))}
                    </div>
                ) : null}
                {/* 화면 읽기 프로그램: 가리킨 칸의 내용 */}
                <span className="sr-only" aria-live="polite">
                    {shown ? summary(shown) : ''}
                </span>
            </div>
        </div>
    );
}
