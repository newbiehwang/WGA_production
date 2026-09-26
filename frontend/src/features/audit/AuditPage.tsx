// 감사 로그 화면: 누가 언제 어떤 질문으로 어떤 도구를 불렀고 결과가 어땠는지 (GET /audit, services/llm/audit.py).
// 관리자만 여는 화면이다. 구성은 Datadog Audit Trail을 따랐다 (패널·배지·버튼 모양은 이 앱의 것을 그대로 쓴다).
//   머리: 제목 · 새로 고침(아이콘)
//   왼쪽: 거르기 목록(FacetSidebar) — 종류·결과·층·요청자·도구·출처·표시. 값마다 건수, 여러 값을 함께 고른다
//   오른쪽: 기간(PeriodPicker) · 건수 · 시간대별 막대그래프(AuditHistogram, 드래그로 기간 좁히기)
//           · 목록(시각 · 요청자 · 도구 · 요약 · 결과 · 표시). 내려가면 이어서 더 그린다
//   행을 누르면 오른쪽에서 옆 패널(AuditSidePanel)이 나와 자세히 보인다. ↑/↓로 앞뒤 기록, 변경 작업은 '층별로 따져 보기'
//
// 기간 안의 기록을 모두 받아(useAuditRecords, 2,000건까지) 거르기·건수·막대는 브라우저에서 계산한다.
// 기간과 거르기는 주소에 담는다(auditUrl.ts): 링크로 같은 화면을 나누고, 새로 고쳐도 남는다
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LoadingCard, useMinimumVisible } from '@/components/LoadingCard';
import { RefreshButton } from '@/components/RefreshButton';
import type { AuditRecord } from '@/types/audit';
import { formatKoreanDateTimeSeconds } from '@/utils/formatters';
import { Flags, KindLabel, ResultBadge } from './AuditDetails';
import { AuditHistogram } from './AuditHistogram';
import { AuditSidePanel } from './AuditSidePanel';
import { activeCount, keyOf, matches, requesterOf, secondsOf, summaryOf, timeOf, type Selection } from './auditModel';
import { readUrl, writeUrl } from './auditUrl';
import { FacetSidebar } from './FacetSidebar';
import { PeriodPicker } from './PeriodPicker';
import { containsRange, fetchRangeOf, windowOf, type Period } from './timeWindow';
import { MAX_RECORDS, useAuditRecords } from './useAuditRecords';
import './audit.css';

const RENDER_STEP = 100; // 목록은 이만큼씩 그린다 (2,000행을 한 번에 그리지 않게). 끝에 닿으면 다음 묶음

// 목록의 행 버튼 (옆 패널을 닫으면 여기로 포커스를 돌려준다). data-key로 찾는다
const rowButtonOf = (key: string) =>
    document.querySelector<HTMLButtonElement>(`.audit-row-button[data-key="${CSS.escape(key)}"]`);

// 목록 한 행. 누르면 옆 패널로 자세히 본다
function AuditRow({ record, selected, onOpen }: { record: AuditRecord; selected: boolean; onOpen: () => void }) {
    const summary = summaryOf(record);
    return (
        <li className={`audit-row${selected ? ' is-selected' : ''}`}>
            <button
                type="button"
                className="audit-row-button"
                data-key={keyOf(record)}
                aria-haspopup="dialog"
                aria-current={selected ? 'true' : undefined}
                onClick={onOpen}
            >
                <span className="audit-col-time">{formatKoreanDateTimeSeconds(timeOf(record))}</span>
                <span className="audit-col-user" title={record.userId}>
                    {requesterOf(record)}
                </span>
                <span className="audit-col-tool" title={record.tool}>
                    <KindLabel record={record} />
                </span>
                <span className="audit-col-summary" title={summary}>
                    {summary || <span className="audit-muted">-</span>}
                </span>
                <span className="audit-col-status">
                    <ResultBadge record={record} />
                    <span className="audit-ms">{secondsOf(record.ms)}</span>
                </span>
                <span className="audit-col-flags">
                    <Flags record={record} />
                </span>
            </button>
        </li>
    );
}

// 목록 끝에 닿으면 onReach를 부른다 (다음 묶음을 그린다)
function EndSentinel({ onReach }: { onReach: () => void }) {
    const ref = useRef<HTMLLIElement>(null);
    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        const observer = new IntersectionObserver((entries) => entries[0]?.isIntersecting && onReach(), {
            root: node.parentElement,
            rootMargin: '200px',
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [onReach]);
    return <li ref={ref} className="audit-sentinel" aria-hidden="true" />;
}

export function AuditPage() {
    const [params, setParams] = useSearchParams();
    const [initial] = useState(() => readUrl(params)); // 처음 열 때만 주소에서 읽는다 (그 뒤로는 화면이 주소를 쓴다)
    const [period, setPeriod] = useState<Period>(initial.period);
    const [selection, setSelection] = useState<Selection>(initial.selection);
    const [now, setNow] = useState(() => Date.now()); // '최근 n시간'의 끝. 새로 고침하면 지금으로
    const timeWindow = useMemo(() => windowOf(period, now), [period, now]);

    // 받아 올 범위(UTC 날짜): 이미 받은 범위 안에서 기간을 좁히면(7일 → 1일, 막대 드래그) 다시 받지 않는다.
    // 다만 2,000건 한도로 잘려 기간의 앞쪽이 비어 있으면 그 기간만 다시 받는다
    const wanted = fetchRangeOf(timeWindow);
    const [fetchRange, setFetchRange] = useState(wanted);
    const { records, loading, received, truncated, error, reload } = useAuditRecords(fetchRange);
    const oldest = records.length ? Date.parse(timeOf(records[records.length - 1])) : Infinity;
    useEffect(() => {
        const missing = !containsRange(fetchRange, wanted) || (truncated && !loading && timeWindow.from < oldest);
        if (missing && (fetchRange.from !== wanted.from || fetchRange.to !== wanted.to)) setFetchRange(wanted);
    }, [wanted.from, wanted.to, fetchRange, truncated, loading, timeWindow.from, oldest]); // wanted는 글자 두 개로 비교한다 (매번 새 객체)
    const listLoading = useMinimumVisible(loading); // 흰 박스 가운데의 기다림 카드 (최소 1초)

    // 조건을 주소에 담는다 (뒤로 가기가 조건마다 쌓이지 않게 replace). 주소가 바뀌어도 다시 돌지 않게 조건만 지켜본다
    useEffect(() => {
        const next = writeUrl(params, period, selection);
        if (next.toString() !== params.toString()) setParams(next, { replace: true });
    }, [period, selection]);

    // 기간 안의 기록 (받은 범위는 UTC 날짜 단위라 기간보다 넓다)
    const inWindow = useMemo(
        () =>
            records.filter((record) => {
                const at = Date.parse(timeOf(record));
                return at >= timeWindow.from && at <= timeWindow.to;
            }),
        [records, timeWindow.from, timeWindow.to],
    );

    const [showFacets, setShowFacets] = useState(false); // 좁은 화면: 거르기 목록을 펼쳤는가
    const [openKey, setOpenKey] = useState<string | null>(null); // 옆 패널로 보고 있는 기록
    const [limit, setLimit] = useState(RENDER_STEP);

    const filtered = useMemo(() => inWindow.filter((record) => matches(record, selection)), [inWindow, selection]);
    const conditions = activeCount(selection);

    // 조건이나 기록이 바뀌면 목록을 처음 묶음부터 그린다
    useEffect(() => setLimit(RENDER_STEP), [filtered]);

    const openIndex = openKey ? filtered.findIndex((record) => keyOf(record) === openKey) : -1;
    // 보고 있던 기록이 거르기로 목록에서 빠지면 패널을 닫는다
    useEffect(() => {
        if (openKey && openIndex < 0) setOpenKey(null);
    }, [openKey, openIndex]);

    const closePanel = () => {
        const key = openKey;
        setOpenKey(null);
        if (key) rowButtonOf(key)?.focus(); // 보던 기록의 행으로 포커스를 돌려준다 (키보드로 이어서 읽는다)
    };

    // 옆 패널에서 ↑/↓: 거른 목록의 앞뒤 기록으로 옮기고, 그 행이 목록에서 보이게 스크롤한다
    const move = (step: -1 | 1) => {
        const next = filtered[openIndex + step];
        if (!next) return;
        const key = keyOf(next);
        setLimit((prev) => Math.max(prev, openIndex + step + 1 + RENDER_STEP / 2));
        setOpenKey(key);
        window.requestAnimationFrame(() => rowButtonOf(key)?.scrollIntoView({ block: 'nearest' }));
    };

    const showMore = useCallback(() => setLimit((prev) => prev + RENDER_STEP), []);

    return (
        <section className="plan-panel audit-panel" aria-label="감사 로그">
            <div className="plan-panel-header">
                <h1 className="plan-panel-eyebrow">감사 로그</h1>
                <RefreshButton
                    onClick={() => {
                        setNow(Date.now());
                        reload();
                    }}
                    loading={loading || listLoading}
                />
            </div>

            {error ? (
                <div className="plan-panel-error-inline" role="alert">
                    <p>{error}</p>
                </div>
            ) : null}

            <div className={`audit-explorer${showFacets ? ' is-facets-open' : ''}`}>
                <FacetSidebar records={inWindow} selection={selection} onChange={setSelection} />

                <div className="audit-results">
                    <div className="audit-toolbar">
                        <PeriodPicker period={period} window={timeWindow} onChange={setPeriod} />
                        <button
                            type="button"
                            className="audit-facets-button"
                            aria-expanded={showFacets}
                            onClick={() => setShowFacets((prev) => !prev)}
                        >
                            거르기{conditions ? ` ${conditions}` : ''}
                        </button>
                        <p className="audit-count" role="status">
                            {listLoading ? null : (
                                <>
                                    <strong>{filtered.length.toLocaleString()}건</strong>
                                    {conditions ? <span className="audit-muted"> / {inWindow.length.toLocaleString()}건 중</span> : null}
                                    {truncated ? (
                                        <span className="audit-truncated">
                                            최근 {MAX_RECORDS.toLocaleString()}건까지만 불러왔습니다. 기간을 줄이면 모두 봅니다
                                        </span>
                                    ) : null}
                                </>
                            )}
                        </p>
                        {conditions ? (
                            <button type="button" className="audit-clear-all" onClick={() => setSelection({})}>
                                조건 모두 지우기
                            </button>
                        ) : null}
                    </div>

                    {listLoading || error ? null : (
                        <AuditHistogram records={filtered} window={timeWindow} onSelect={setPeriod} />
                    )}

                    <div className="plan-table audit-table">
                        <div className="plan-table-header audit-table-header" aria-hidden="true">
                            <span className="audit-col-time">시각</span>
                            <span className="audit-col-user">요청자</span>
                            <span className="audit-col-tool">도구</span>
                            <span className="audit-col-summary">요약</span>
                            <span className="audit-col-status">결과</span>
                            <span className="audit-col-flags">표시</span>
                        </div>

                        {/* 불러오는 동안 목록은 비워 두고, 카드는 흰 박스 전체의 가운데에 띄운다 (아래 plan-panel-loading) */}
                        {listLoading || error ? null : filtered.length === 0 ? (
                            <div className="plan-panel-empty">
                                {inWindow.length === 0 ? (
                                    <p>이 기간에 기록이 없습니다. 질문을 보내면 도구 호출마다 기록이 남습니다.</p>
                                ) : (
                                    <p>이 조건에 맞는 기록이 없습니다.</p>
                                )}
                            </div>
                        ) : (
                            <ul className="audit-table-body" aria-label="감사 기록">
                                {filtered.slice(0, limit).map((record) => {
                                    const key = keyOf(record);
                                    return (
                                        <AuditRow
                                            key={key}
                                            record={record}
                                            selected={openKey === key}
                                            onOpen={() => setOpenKey(key)}
                                        />
                                    );
                                })}
                                {limit < filtered.length ? <EndSentinel onReach={showMore} /> : null}
                            </ul>
                        )}
                    </div>
                </div>
            </div>

            {listLoading ? (
                <div className="plan-panel-loading">
                    <LoadingCard
                        text={received ? `감사 로그를 불러오는 중… ${received.toLocaleString()}건` : '감사 로그를 불러오는 중…'}
                    />
                </div>
            ) : null}

            {openKey && openIndex >= 0 ? (
                <AuditSidePanel
                    record={filtered[openIndex]}
                    index={openIndex}
                    total={filtered.length}
                    onMove={move}
                    onClose={closePanel}
                />
            ) : null}
        </section>
    );
}
