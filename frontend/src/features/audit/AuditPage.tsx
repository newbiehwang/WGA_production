// 감사 로그 화면: 누가 언제 어떤 질문으로 어떤 도구를 불렀고 결과가 어땠는지 (GET /audit, services/llm/audit.py).
// AXPI 패널·목록 행을 그대로 쓴다.
//   머리: 제목 · 새로 고침
//   거르기: 기간 · 결과 · 종류 · 도구 (관리자는 '모든 사용자'도)
//   목록: 시각 · 요청자 · 도구 · 요약 · 결과 · 표시. 행을 누르면 입력값·오류·질문 ID 등이 펼쳐진다
//   아래: 더 보기 (cursor로 이어 읽는다)
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchAudit } from '@/api/audit';
import type { AuditKind, AuditRecord, AuditStatus } from '@/types/audit';
import { formatKoreanDateTimeSeconds } from '@/utils/formatters';
import { labelOf, summarize } from '@/utils/toolTrace';
import './audit.css';

const PAGE_SIZE = 50;

const PERIODS = [
    { days: 1, label: '1일' },
    { days: 7, label: '7일' },
    { days: 30, label: '30일' },
];

const STATUSES: { value: '' | AuditStatus; label: string }[] = [
    { value: '', label: '전체' },
    { value: 'ok', label: '성공' },
    { value: 'error', label: '실패' },
];

const KINDS: { value: '' | AuditKind; label: string }[] = [
    { value: '', label: '전체' },
    { value: 'tool', label: '도구 호출' },
    { value: 'request', label: '질문' },
    { value: 'action', label: '변경 작업' },
];

// 변경 작업의 사건 → 결과 열에 보일 이름과 모양
const ACTION_EVENTS: Record<string, { label: string; className: string }> = {
    requested: { label: '승인 요청', className: 'audit-event-requested' },
    approved: { label: '승인', className: 'plan-status-active' },
    denied: { label: '거절', className: 'plan-status-pending' },
    executed: { label: '실행', className: 'plan-status-complete' },
    failed: { label: '실패', className: 'audit-status-error' },
};

// 가린 값의 종류 → 화면에 보일 이름 (services/llm/redaction.py)
const REDACTED_LABELS: Record<string, string> = {
    aws_access_key: 'AWS 액세스 키',
    aws_secret_key: 'AWS 비밀 키',
    aws_session_token: 'AWS 세션 토큰',
    anthropic_api_key: 'Anthropic 키',
    slack_token: 'Slack 토큰',
    slack_webhook: 'Slack 웹훅',
    github_token: 'GitHub 토큰',
    jwt: '로그인 토큰(JWT)',
    private_key: '개인 키',
    url_password: '접속 주소 비밀번호',
    account_id: '계정 ID',
    email: '이메일',
};

interface Filters {
    days: number;
    scope: 'mine' | 'all';
    status: '' | AuditStatus;
    kind: '' | AuditKind;
    tool: string;
}

// 서버는 날짜를 UTC로 나눠 저장한다. 오늘(UTC)부터 거꾸로 days일
const rangeOf = (days: number) => {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
};

const timeOf = (record: AuditRecord) => record.at.split('#')[0];
const keyOf = (record: AuditRecord) => `${record.userId}|${record.at}`;
const secondsOf = (ms?: number) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}초` : '');
const redactedTotal = (record: AuditRecord) =>
    Object.values(record.redacted ?? {}).reduce((sum, count) => sum + count, 0);

const requesterOf = (record: AuditRecord) => {
    if (record.email) return record.email;
    if (record.userId.startsWith('slack:')) return `Slack ${record.userId.slice('slack:'.length)}`;
    return record.userId;
};

const summaryOf = (record: AuditRecord) => {
    if (record.kind === 'request') return record.question ?? '';
    if (record.kind === 'action') return record.summary ?? '';
    if (typeof record.input === 'string') return record.input;
    return summarize(record.input);
};

const errorText = (error: unknown) => {
    const response = (error as { response?: { status?: number; data?: { error?: string } } })?.response;
    if (response?.data?.error) return response.data.error;
    if (response?.status === 403) return '이 기록을 볼 권한이 없습니다.';
    return '감사 로그를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
};

// 세그먼트 버튼 묶음 (기간·결과·종류·대상)
function Segment<T extends string | number>({
    label,
    options,
    value,
    onChange,
}: {
    label: string;
    options: { value: T; label: string }[];
    value: T;
    onChange: (value: T) => void;
}) {
    return (
        <div className="audit-filter" role="group" aria-label={label}>
            <span className="audit-filter-label" aria-hidden="true">
                {label}
            </span>
            <div className="audit-segment">
                {options.map((option) => (
                    <button
                        key={String(option.value)}
                        type="button"
                        className={`audit-segment-btn${option.value === value ? ' is-active' : ''}`}
                        aria-pressed={option.value === value}
                        onClick={() => onChange(option.value)}
                    >
                        {option.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

function Details({ record }: { record: AuditRecord }) {
    const rows: [string, ReactNode][] = [];
    if (record.kind === 'tool') {
        rows.push(['도구 이름', <code key="tool">{record.tool}</code>]);
        rows.push([
            '입력',
            <pre key="input" className="audit-code">
                {typeof record.input === 'string' ? record.input : JSON.stringify(record.input ?? {}, null, 2)}
            </pre>,
        ]);
        if (record.resultChars !== undefined) rows.push(['결과 크기', `${record.resultChars.toLocaleString()}자`]);
    } else if (record.kind === 'action') {
        rows.push(['사건', ACTION_EVENTS[record.event ?? '']?.label ?? record.event ?? '']);
        rows.push(['변경 내용', record.summary ?? '']);
        rows.push(['도구 이름', <code key="tool">{record.tool}</code>]);
        rows.push([
            '실행될 값',
            <pre key="input" className="audit-code">
                {typeof record.input === 'string' ? record.input : JSON.stringify(record.input ?? {}, null, 2)}
            </pre>,
        ]);
        if (record.decidedBy) rows.push(['결정한 사람', <code key="by">{record.decidedBy}</code>]);
        if (record.result) rows.push(['실행 결과', record.result]);
        if (record.actionId) rows.push(['작업 ID', <code key="action">{record.actionId}</code>]);
    } else {
        rows.push(['질문', record.question ?? '']);
        if (record.model) rows.push(['모델', <code key="model">{record.model}</code>]);
        rows.push(['도구 호출', `${record.toolCount ?? 0}번`]);
        const redacted = Object.entries(record.redacted ?? {});
        rows.push([
            'Claude로 보내기 전에 가린 값',
            redacted.length
                ? redacted.map(([kind, count]) => `${REDACTED_LABELS[kind] ?? kind} ${count}개`).join(', ')
                : '없음',
        ]);
    }
    if (record.error) rows.push(['오류', <span key="error" className="audit-error-text">{record.error}</span>]);
    if (record.ms !== undefined) rows.push(['걸린 시간', secondsOf(record.ms)]);
    rows.push(['요청자 ID', <code key="user">{record.userId}</code>]);
    if (record.requestId) rows.push(['질문 ID', <code key="request">{record.requestId}</code>]);
    if (record.sessionId) rows.push(['대화 ID', <code key="session">{record.sessionId}</code>]);
    if (record.toolUseId) rows.push(['도구 호출 ID', <code key="use">{record.toolUseId}</code>]);

    return (
        <dl className="audit-details">
            {rows.map(([name, value]) => (
                <Fragment key={name}>
                    <dt>{name}</dt>
                    <dd>{value}</dd>
                </Fragment>
            ))}
        </dl>
    );
}

// 결과 열: 변경 작업은 사건(승인 요청·승인·거절·실행·실패), 나머지는 성공·실패
function ResultBadge({ record }: { record: AuditRecord }) {
    const event = record.kind === 'action' ? ACTION_EVENTS[record.event ?? ''] : undefined;
    if (event) return <span className={`plan-status-badge ${event.className}`}>{event.label}</span>;
    const failed = record.status === 'error';
    return (
        <span className={`plan-status-badge ${failed ? 'audit-status-error' : 'plan-status-complete'}`}>
            {failed ? '실패' : '성공'}
        </span>
    );
}

function AuditRow({ record, open, onToggle }: { record: AuditRecord; open: boolean; onToggle: () => void }) {
    const redacted = redactedTotal(record);
    const summary = summaryOf(record);
    const detailsId = `audit-details-${keyOf(record).replace(/[^a-zA-Z0-9_-]/g, '')}`;
    return (
        <li className={`plan-table-row audit-row${open ? ' is-open' : ''}`}>
            <button
                type="button"
                className="audit-row-button"
                aria-expanded={open}
                aria-controls={detailsId}
                onClick={onToggle}
            >
                <span className="audit-col-time">{formatKoreanDateTimeSeconds(timeOf(record))}</span>
                <span className="audit-col-user" title={record.userId}>
                    {requesterOf(record)}
                </span>
                <span className="audit-col-tool" title={record.tool}>
                    {record.kind === 'request' ? (
                        <span className="audit-kind-request">질문</span>
                    ) : record.kind === 'action' ? (
                        <span className="audit-kind-action">{labelOf(record.tool ?? '').replace(/ 요청$/, '')}</span>
                    ) : (
                        labelOf(record.tool ?? '')
                    )}
                </span>
                <span className="audit-col-summary" title={summary}>
                    {summary || <span className="audit-muted">-</span>}
                </span>
                <span className="audit-col-status">
                    <ResultBadge record={record} />
                    <span className="audit-ms">{secondsOf(record.ms)}</span>
                </span>
                <span className="audit-col-flags">
                    {record.source === 'slack' ? <span className="audit-flag">Slack</span> : null}
                    {redacted ? (
                        <span className="audit-flag is-redacted" title="Claude로 보내기 전에 가린 값의 수">
                            가림 {redacted}
                        </span>
                    ) : null}
                </span>
            </button>
            {open ? (
                <div id={detailsId} className="audit-row-details">
                    <Details record={record} />
                </div>
            ) : null}
        </li>
    );
}

export function AuditPage() {
    const [filters, setFilters] = useState<Filters>({ days: 7, scope: 'mine', status: '', kind: '', tool: '' });
    const [items, setItems] = useState<AuditRecord[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [loading, setLoading] = useState<'list' | 'more' | null>('list');
    const [error, setError] = useState<string | null>(null);
    const [openKey, setOpenKey] = useState<string | null>(null);
    // 거르기용 도구 목록: 지금까지 받은 기록에 나온 도구 (서버는 정확한 도구 이름으로만 거른다)
    const [toolNames, setToolNames] = useState<string[]>([]);
    // 조건을 빠르게 바꾸면 앞 요청의 응답이 늦게 올 수 있다. 마지막 요청의 응답만 쓴다
    const requestNo = useRef(0);

    const load = useCallback(
        async (next?: string) => {
            const no = ++requestNo.current;
            setLoading(next ? 'more' : 'list');
            setError(null);
            try {
                const page = await fetchAudit({
                    ...rangeOf(filters.days),
                    scope: filters.scope,
                    status: filters.status || undefined,
                    kind: filters.kind || undefined,
                    tool: filters.tool || undefined,
                    limit: PAGE_SIZE,
                    cursor: next,
                });
                if (no !== requestNo.current) return;
                setItems((prev) => (next ? [...prev, ...page.items] : page.items));
                setCursor(page.cursor);
                setIsAdmin(page.isAdmin);
                setToolNames((prev) => {
                    const found = page.items.map((item) => item.tool).filter((name): name is string => !!name);
                    return [...new Set([...prev, ...found])].sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
                });
            } catch (err) {
                if (no !== requestNo.current) return;
                setError(errorText(err));
                if (!next) setItems([]);
            } finally {
                if (no === requestNo.current) setLoading(null);
            }
        },
        [filters],
    );

    // 조건이 바뀌면 처음부터 다시 읽는다
    useEffect(() => {
        setOpenKey(null);
        load();
    }, [load]);

    const update = (change: Partial<Filters>) => setFilters((prev) => ({ ...prev, ...change }));

    return (
        <section className="plan-panel audit-panel" aria-label="감사 로그">
            <div className="plan-panel-header">
                <div>
                    <h1 className="plan-panel-eyebrow">감사 로그</h1>
                    <p className="plan-panel-subtitle">
                        누가 언제 어떤 도구를 어떤 입력으로 불렀는지 남긴 기록입니다. 시각은 한국 시간이며,
                        <strong> 90일</strong> 동안 보관합니다.
                    </p>
                </div>
                <button
                    type="button"
                    className="plan-reload-button"
                    onClick={() => load()}
                    disabled={loading !== null}
                >
                    새로 고침
                </button>
            </div>

            <div className="audit-filters">
                <Segment
                    label="기간"
                    options={PERIODS.map((p) => ({ value: p.days, label: p.label }))}
                    value={filters.days}
                    onChange={(days) => update({ days })}
                />
                {isAdmin ? (
                    <Segment
                        label="대상"
                        options={[
                            { value: 'mine' as const, label: '내 기록' },
                            { value: 'all' as const, label: '모든 사용자' },
                        ]}
                        value={filters.scope}
                        onChange={(scope) => update({ scope })}
                    />
                ) : null}
                <Segment label="결과" options={STATUSES} value={filters.status} onChange={(status) => update({ status })} />
                <Segment label="종류" options={KINDS} value={filters.kind} onChange={(kind) => update({ kind })} />
                <label className="audit-filter">
                    <span className="audit-filter-label">도구</span>
                    <select
                        className="audit-select"
                        value={filters.tool}
                        onChange={(event) => update({ tool: event.target.value })}
                    >
                        <option value="">모든 도구</option>
                        {toolNames.map((name) => (
                            <option key={name} value={name}>
                                {labelOf(name)}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            {error ? (
                <div className="plan-panel-error-inline" role="alert">
                    <p>{error}</p>
                </div>
            ) : null}

            <div className="plan-panel-body">
                <div className="plan-table audit-table">
                    <div className="plan-table-header audit-table-header" aria-hidden="true">
                        <span className="audit-col-time">시각</span>
                        <span className="audit-col-user">요청자</span>
                        <span className="audit-col-tool">도구</span>
                        <span className="audit-col-summary">요약</span>
                        <span className="audit-col-status">결과</span>
                        <span className="audit-col-flags">표시</span>
                    </div>

                    {loading === 'list' ? (
                        <div className="plan-panel-loading" role="status">
                            <div>
                                <div className="plan-inline-spinner" />
                                <p>감사 로그를 불러오는 중…</p>
                            </div>
                        </div>
                    ) : items.length === 0 ? (
                        error ? null : (
                            <div className="plan-panel-empty">
                                <p>이 조건에 맞는 기록이 없습니다. 질문을 보내면 도구 호출마다 기록이 남습니다.</p>
                            </div>
                        )
                    ) : (
                        <ul className="plan-table-body audit-table-body" aria-label="감사 기록">
                            {items.map((record) => {
                                const key = keyOf(record);
                                return (
                                    <AuditRow
                                        key={key}
                                        record={record}
                                        open={openKey === key}
                                        onToggle={() => setOpenKey((prev) => (prev === key ? null : key))}
                                    />
                                );
                            })}
                            {cursor ? (
                                <li className="audit-more">
                                    <button
                                        type="button"
                                        className="plan-reload-button"
                                        onClick={() => load(cursor)}
                                        disabled={loading !== null}
                                    >
                                        {loading === 'more' ? '불러오는 중…' : '더 보기'}
                                    </button>
                                </li>
                            ) : null}
                        </ul>
                    )}
                </div>
            </div>
        </section>
    );
}
