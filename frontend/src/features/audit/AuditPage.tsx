// 감사 로그 화면: 누가 언제 어떤 질문으로 어떤 도구를 불렀고 결과가 어땠는지 (GET /audit, services/llm/audit.py).
// AXPI 패널·목록 행을 그대로 쓴다.
//   머리: 제목 · 새로 고침(아이콘)
//   거르기: 기간 · 대상 · 결과 · 종류 · 층 · 도구 (관리자만 여는 화면이다)
//   목록: 시각 · 요청자 · 도구 · 요약 · 결과 · 표시. 행을 누르면 팝업창(AuditDetailModal)에 입력값·오류·질문 ID 등이 보인다
//         변경 작업은 팝업창에서 '층별로 따져 보기'로 역추적을 연다 (AuditTrace)
//   아래: 더 보기 (cursor로 이어 읽는다)
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fetchAudit } from '@/api/audit';
import { ROLE_LABELS, type Role } from '@/auth/authClient';
import { LoadingCard, useMinimumVisible } from '@/components/LoadingCard';
import { RefreshButton } from '@/components/RefreshButton';
import type { AuditKind, AuditLocus, AuditRecord, AuditStatus } from '@/types/audit';
import { formatKoreanDateTimeSeconds } from '@/utils/formatters';
import { AuditTrace } from './AuditTrace';
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
    { value: 'admin', label: '사용자 관리' },
];

// 사용자 관리의 사건 (services/llm/user_admin.py)
const ADMIN_EVENTS: Record<string, string> = {
    invited: '초대',
    role_changed: '권한 변경',
    group_added: '그룹 추가',
    group_removed: '그룹 제외',
    disabled: '정지',
    enabled: '정지 해제',
};
const GROUP_NAMES: Record<string, string> = { admins: '관리자', approvers: '결정자' };
const roleText = (role?: string) => (role ? ROLE_LABELS[role as Role] ?? role : '');
const adminSummaryOf = (record: AuditRecord) =>
    [
        record.targetEmail ?? record.targetUser,
        ADMIN_EVENTS[record.event ?? ''] ?? record.event,
        record.toRole ? `${roleText(record.fromRole)} → ${roleText(record.toRole)}` : null,
        record.group ? GROUP_NAMES[record.group] ?? record.group : null,
    ]
        .filter(Boolean)
        .join(' · ');

// 층 (services/llm/audit.py 모듈 설명, fingate-x의 '원인의 계층'을 참고). 사고가 나면 어느 층이 뚫렸는지 좁혀 본다.
// 판단층(모델 안)은 기록할 수 없어 없다: 유입·체류·유출이 함께 보이면 그 층이 뚫린 것으로 본다
const LOCI: { value: AuditLocus; label: string; description: string }[] = [
    { value: 'interface', label: '경계', description: '위험도 등록부에 없는 도구를 불렀습니다. 변경 도구로 다룹니다' },
    { value: 'ingress', label: '유입', description: '조회·결과물 도구의 결과가 들어왔습니다' },
    { value: 'residence', label: '체류', description: '의심 문구가 든 결과를 읽은 뒤 같은 질문에서 변경을 요청했습니다' },
    { value: 'egress', label: '유출', description: '변경 도구를 부르려 했습니다. 실행하지 않고 승인을 요청합니다' },
    { value: 'effect', label: '효과', description: '승인·거절·실행·실패' },
];
const LOCUS_OPTIONS: { value: '' | AuditLocus; label: string }[] = [
    { value: '', label: '전체' },
    ...LOCI.map(({ value, label }) => ({ value, label })),
];
const locusOf = (value?: string) => LOCI.find((locus) => locus.value === value);

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
    locus: '' | AuditLocus;
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
const suspiciousOf = (record: AuditRecord) =>
    Array.isArray(record.injectionSuspected) ? record.injectionSuspected.length > 0 : !!record.injectionSuspected;
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
    if (record.kind === 'admin') return adminSummaryOf(record);
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
    const locus = locusOf(record.locus);
    if (locus)
        rows.push([
            '층',
            <span key="locus">
                {locus.label} <span className="audit-muted">({locus.description})</span>
            </span>,
        ]);
    if (record.kind === 'tool') {
        rows.push(['도구 이름', <code key="tool">{record.tool}</code>]);
        rows.push([
            '입력',
            <pre key="input" className="audit-code">
                {typeof record.input === 'string' ? record.input : JSON.stringify(record.input ?? {}, null, 2)}
            </pre>,
        ]);
        if (record.resultChars !== undefined) rows.push(['결과 크기', `${record.resultChars.toLocaleString()}자`]);
        if (Array.isArray(record.injectionSuspected) && record.injectionSuspected.length)
            rows.push(['의심 문구', `지시문처럼 보이는 문구 (${record.injectionSuspected.join(', ')}). 데이터로만 다뤘습니다`]);
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
        if (record.taintedBy?.length)
            rows.push([
                '먼저 읽은 의심 결과',
                <ul key="tainted" className="audit-tainted">
                    {record.taintedBy.map((seen) => (
                        <li key={seen.toolUseId}>
                            {labelOf(seen.tool)} 결과 ·{' '}
                            {seen.callsAgo <= 1 ? '바로 다음 호출' : `${seen.callsAgo}번째 뒤 호출`}에서 요청 ·{' '}
                            <span className="audit-muted">{seen.kinds.join(', ')}</span> ·{' '}
                            <code>{seen.toolUseId}</code>
                        </li>
                    ))}
                </ul>,
            ]);
        if (record.decidedBy) rows.push(['결정한 사람', <code key="by">{record.decidedBy}</code>]);
        if (record.result) rows.push(['실행 결과', record.result]);
        if (record.awsRequestId)
            rows.push([
                'CloudTrail',
                <span key="trail">
                    {record.cloudTrailEvent} · 요청 ID <code>{record.awsRequestId}</code>
                    <span className="audit-muted"> (CloudTrail 이벤트의 requestID와 같습니다)</span>
                </span>,
            ]);
        if (record.actionId) rows.push(['작업 ID', <code key="action">{record.actionId}</code>]);
    } else if (record.kind === 'admin') {
        rows.push(['사건', ADMIN_EVENTS[record.event ?? ''] ?? record.event ?? '']);
        rows.push(['대상', record.targetEmail ?? '']);
        if (record.targetUser) rows.push(['대상 사용자 이름', <code key="target">{record.targetUser}</code>]);
        if (record.toRole) rows.push(['권한', `${roleText(record.fromRole)} → ${roleText(record.toRole)}`]);
        if (record.group) rows.push(['그룹', `${GROUP_NAMES[record.group] ?? record.group} (${record.group})`]);
        if (record.decidedBy) rows.push(['바꾼 사람', <code key="by">{record.decidedBy}</code>]);
        if (record.status === 'error')
            rows.push(['결과', '바꾸지 못했습니다 (바로 앞의 같은 사건 행은 시도를 기록한 것입니다)']);
    } else {
        rows.push(['질문', record.question ?? '']);
        if (record.model) rows.push(['모델', <code key="model">{record.model}</code>]);
        rows.push(['도구 호출', `${record.toolCount ?? 0}번`]);
        if (record.injectionSuspected) rows.push(['의심 문구가 든 도구 결과', `${record.injectionSuspected}건`]);
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
        <>
            <dl className="audit-details">
                {rows.map(([name, value]) => (
                    <Fragment key={name}>
                        <dt>{name}</dt>
                        <dd>{value}</dd>
                    </Fragment>
                ))}
            </dl>
            {record.kind === 'action' && record.actionId ? (
                <TraceSection actionId={record.actionId} day={record.day} />
            ) : null}
        </>
    );
}

// 변경 작업 행: 누르면 역추적을 연다 (누를 때만 서버에 묻는다)
function TraceSection({ actionId, day }: { actionId: string; day: string }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="audit-trace-section">
            <button
                type="button"
                className="plan-reload-button"
                aria-expanded={open}
                onClick={() => setOpen((prev) => !prev)}
            >
                {open ? '역추적 닫기' : '층별로 따져 보기'}
            </button>
            {open ? <AuditTrace actionId={actionId} day={day} /> : null}
        </div>
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

// 도구 칸: 질문·변경 작업·사용자 관리는 종류를, 도구 호출은 도구 이름을 보인다 (목록 행과 팝업창 제목이 같이 쓴다)
function KindLabel({ record }: { record: AuditRecord }) {
    if (record.kind === 'request') return <span className="audit-kind-request">질문</span>;
    if (record.kind === 'action')
        return <span className="audit-kind-action">{labelOf(record.tool ?? '').replace(/ 요청$/, '')}</span>;
    if (record.kind === 'admin') return <span className="audit-kind-admin">사용자 관리</span>;
    return <>{labelOf(record.tool ?? '')}</>;
}

// 표시 칸: Slack · 의심 문구 · 의심 뒤 요청 · 미등록 도구 · 가림 (목록 행과 팝업창 머리가 같이 쓴다)
function Flags({ record }: { record: AuditRecord }) {
    const redacted = redactedTotal(record);
    return (
        <>
            {record.source === 'slack' ? <span className="audit-flag">Slack</span> : null}
            {suspiciousOf(record) ? (
                <span className="audit-flag is-suspicious" title="도구 결과에 지시문처럼 보이는 문구가 있었습니다">
                    의심 문구
                </span>
            ) : null}
            {record.taintedBy?.length ? (
                <span
                    className="audit-flag is-suspicious"
                    title="의심 문구가 든 도구 결과를 읽은 뒤 같은 질문에서 요청한 변경입니다 (체류)"
                >
                    의심 뒤 요청
                </span>
            ) : null}
            {record.locus === 'interface' ? (
                <span className="audit-flag is-suspicious" title="위험도 등록부에 없는 도구입니다 (경계)">
                    미등록 도구
                </span>
            ) : null}
            {redacted ? (
                <span className="audit-flag is-redacted" title="Claude로 보내기 전에 가린 값의 수">
                    가림 {redacted}
                </span>
            ) : null}
        </>
    );
}

// 목록 한 행. 누르면 팝업창으로 자세히 본다 (행 안에서 펼치지 않는다)
function AuditRow({
    record,
    open,
    onOpen,
}: {
    record: AuditRecord;
    open: boolean;
    onOpen: (button: HTMLButtonElement) => void; // 누른 행 버튼 (팝업창을 닫으면 여기로 포커스를 돌려준다)
}) {
    const summary = summaryOf(record);
    return (
        <li className={`plan-table-row audit-row${open ? ' is-open' : ''}`}>
            <button
                type="button"
                className="audit-row-button"
                aria-haspopup="dialog"
                onClick={(event) => onOpen(event.currentTarget)}
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

const CLOSE_MS = 180; // 닫히는 효과 시간 (대화 목록 팝업창과 같다: model-overlay-out·model-sheet-out)

// 기록 한 건을 자세히 보는 팝업창. 모양과 여닫는 효과는 대화 목록 팝업창(SessionListModal)과 같다:
// 오른쪽 위 ✕, 큰 제목(도구·종류), 그 아래 시각·요청자·결과·표시, 본문은 항목 표(Details). 본문이 길면 팝업창 안에서 스크롤한다.
// Esc·바깥 누르기·✕로 닫는다. 열릴 때 팝업창 자체에 포커스를 두고(화면 읽기 프로그램이 제목부터 읽는다),
// 닫으면 부르는 쪽이 눌렀던 행으로 포커스를 돌려준다
function AuditDetailModal({ record, onClose }: { record: AuditRecord; onClose: () => void }) {
    const [isClosing, setIsClosing] = useState(false);
    const dialog = useRef<HTMLDivElement>(null);

    const close = () => {
        if (isClosing) return;
        setIsClosing(true);
        window.setTimeout(onClose, CLOSE_MS);
    };

    useEffect(() => {
        dialog.current?.focus();
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') close();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    });

    return createPortal(
        <div
            className={`create-plan-model-overlay${isClosing ? ' is-closing' : ''}`}
            role="presentation"
            onClick={close}
        >
            <div
                ref={dialog}
                tabIndex={-1}
                className="create-plan-model audit-detail-model"
                role="dialog"
                aria-modal="true"
                aria-labelledby="audit-detail-title"
                onClick={(event) => event.stopPropagation()}
            >
                <button className="vdt-model-close" type="button" onClick={close} aria-label="닫기">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                </button>
                <div className="audit-detail-head">
                    <h3 id="audit-detail-title" className="create-plan-step-heading">
                        <KindLabel record={record} />
                    </h3>
                    <div className="audit-detail-meta">
                        <span>{formatKoreanDateTimeSeconds(timeOf(record))}</span>
                        <span title={record.userId}>{requesterOf(record)}</span>
                        <ResultBadge record={record} />
                        <Flags record={record} />
                    </div>
                </div>
                <div className="audit-detail-body">
                    <Details record={record} />
                </div>
            </div>
        </div>,
        document.body,
    );
}

export function AuditPage() {
    // 관리자만 여는 화면이므로 처음부터 모든 사용자의 기록을 보인다
    const [filters, setFilters] = useState<Filters>({
        days: 7,
        scope: 'all',
        status: '',
        kind: '',
        locus: '',
        tool: '',
    });
    const [items, setItems] = useState<AuditRecord[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState<'list' | 'more' | null>('list');
    const listLoading = useMinimumVisible(loading === 'list'); // 목록 자리의 기다림 카드 (최소 1초)
    const [error, setError] = useState<string | null>(null);
    const [openKey, setOpenKey] = useState<string | null>(null); // 팝업창으로 보고 있는 기록
    const opener = useRef<HTMLButtonElement | null>(null); // 그 기록의 행 버튼
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
                    locus: filters.locus || undefined,
                    tool: filters.tool || undefined,
                    limit: PAGE_SIZE,
                    cursor: next,
                });
                if (no !== requestNo.current) return;
                setItems((prev) => (next ? [...prev, ...page.items] : page.items));
                setCursor(page.cursor);
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
    // 팝업창에 보일 기록 (목록에서 누른 행)
    const openRecord = openKey ? items.find((record) => keyOf(record) === openKey) : undefined;

    return (
        <section className="plan-panel audit-panel" aria-label="감사 로그">
            <div className="plan-panel-header">
                <h1 className="plan-panel-eyebrow">감사 로그</h1>
                <RefreshButton onClick={() => load()} loading={loading !== null || listLoading} />
            </div>

            <div className="audit-filters">
                <Segment
                    label="기간"
                    options={PERIODS.map((p) => ({ value: p.days, label: p.label }))}
                    value={filters.days}
                    onChange={(days) => update({ days })}
                />
                <Segment
                    label="대상"
                    options={[
                        { value: 'all' as const, label: '모든 사용자' },
                        { value: 'mine' as const, label: '내 기록' },
                    ]}
                    value={filters.scope}
                    onChange={(scope) => update({ scope })}
                />
                <Segment label="결과" options={STATUSES} value={filters.status} onChange={(status) => update({ status })} />
                <Segment label="종류" options={KINDS} value={filters.kind} onChange={(kind) => update({ kind })} />
                <Segment
                    label="층"
                    options={LOCUS_OPTIONS}
                    value={filters.locus}
                    onChange={(locus) => update({ locus })}
                />
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

                    {/* 불러오는 동안 목록은 비워 두고, 카드는 흰 박스 전체의 가운데에 띄운다 (아래 plan-panel-loading) */}
                    {listLoading ? null : items.length === 0 ? (
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
                                        onOpen={(button) => {
                                            opener.current = button;
                                            setOpenKey(key);
                                        }}
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

            {listLoading ? (
                <div className="plan-panel-loading">
                    <LoadingCard text="감사 로그를 불러오는 중…" />
                </div>
            ) : null}

            {openRecord ? (
                <AuditDetailModal
                    record={openRecord}
                    onClose={() => {
                        setOpenKey(null);
                        opener.current?.focus(); // 눌렀던 행으로 포커스를 돌려준다 (키보드로 이어서 읽는다)
                    }}
                />
            ) : null}
        </section>
    );
}
