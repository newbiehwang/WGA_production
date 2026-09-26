// 감사 로그의 기간: 전체(기본) · 미리 정한 기간(최근 1시간·4시간·1일·7일·30일) · 직접 정한 구간(막대그래프 드래그·날짜 입력).
// - 전체: 서버가 감사 기록을 보관하는 90일(services/llm/audit.py AUDIT_TTL_DAYS, DynamoDB TTL)
// - 화면의 시각은 앱 전체가 한국 시간(UTC+9)으로 보이므로(utils/formatters.ts), 막대 나누기·날짜 입력도 한국 시간으로 한다
// - 서버는 날짜를 UTC로 나눠 저장한다(services/llm/audit.py). 받아 올 범위는 구간이 걸친 UTC 날짜들이고,
//   받은 기록 중 구간 안의 것만 쓴다 (그래서 '최근 1시간'도 정확하다)
// - 서버는 전체 사용자 기록을 한 번에 31일(UTC 날짜 수)까지 조회하므로, 그보다 긴 기간은 useAuditRecords가 나눠 부른다

export type PresetId = 'all' | '1h' | '4h' | '1d' | '7d' | '30d';
export type Period = { preset: PresetId } | { from: number; to: number }; // 직접 정한 구간 (밀리초)
export interface TimeWindow {
    from: number;
    to: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const KST = 9 * HOUR;
export const RETENTION_DAYS = 90; // 서버의 감사 기록 보관 기간 (services/llm/audit.py AUDIT_TTL_DAYS)
export const MAX_DAYS = RETENTION_DAYS; // 직접 정하는 구간의 최대 길이 (보관 기간보다 길 필요가 없다)

export const PRESETS: { id: PresetId; label: string; ms: number }[] = [
    { id: 'all', label: '전체', ms: RETENTION_DAYS * DAY },
    { id: '1h', label: '1시간', ms: HOUR },
    { id: '4h', label: '4시간', ms: 4 * HOUR },
    { id: '1d', label: '1일', ms: DAY },
    { id: '7d', label: '7일', ms: 7 * DAY },
    { id: '30d', label: '30일', ms: 30 * DAY },
];
export const DEFAULT_PERIOD: Period = { preset: 'all' };

export const isPreset = (period: Period): period is { preset: PresetId } => 'preset' in period;
export const isDefaultPeriod = (period: Period) =>
    isPreset(period) && period.preset === (DEFAULT_PERIOD as { preset: PresetId }).preset;

export const windowOf = (period: Period, now: number): TimeWindow => {
    if (!isPreset(period)) return period;
    const preset = PRESETS.find((p) => p.id === period.preset) ?? PRESETS[0];
    return { from: now - preset.ms, to: now };
};

// 기간 이름 (필터 칩): '전체', '최근 7일' 또는 직접 정한 구간(9. 21. 09:00 ~ 9. 22. 18:00)
export const periodLabel = (period: Period) => {
    if (!isPreset(period)) return formatWindow(period);
    if (period.preset === 'all') return '전체';
    return `최근 ${PRESETS.find((p) => p.id === period.preset)?.label ?? ''}`;
};

// ---------------------------------------------------------------- 받아 올 범위 (UTC 날짜)

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const fetchRangeOf = (window: TimeWindow) => ({ from: utcDay(window.from), to: utcDay(window.to) });
export const daySpan = (window: TimeWindow) => {
    const { from, to } = fetchRangeOf(window);
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
};
export const containsRange = (outer: { from: string; to: string }, inner: { from: string; to: string }) =>
    outer.from <= inner.from && inner.to <= outer.to;

// ---------------------------------------------------------------- 한국 시간 글자

const kstParts = (ms: number) => {
    const d = new Date(ms + KST);
    return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hh: String(d.getUTCHours()).padStart(2, '0'),
        mm: String(d.getUTCMinutes()).padStart(2, '0'),
    };
};

// 9. 20. 14:00
export const formatShort = (ms: number) => {
    const p = kstParts(ms);
    return `${p.month}. ${p.day}. ${p.hh}:${p.mm}`;
};
export const formatWindow = (window: TimeWindow) => `${formatShort(window.from)} ~ ${formatShort(window.to)}`;

// <input type="datetime-local">의 값(YYYY-MM-DDTHH:mm)을 한국 시간으로 읽고 쓴다
export const toInputValue = (ms: number) => {
    const p = kstParts(ms);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${p.hh}:${p.mm}`;
};
export const fromInputValue = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match) return NaN;
    const [, y, mo, d, h, mi] = match.map(Number);
    return Date.UTC(y, mo - 1, d, h, mi) - KST;
};

// ---------------------------------------------------------------- 막대 칸

const MINUTE = 60 * 1000;
// 칸의 크기 후보. 구간을 MAX_BUCKETS칸 이하로 나누는 가장 작은 것을 쓴다.
// 12시간 칸은 두지 않는다: 30일을 12시간으로 나누면 하루가 막대 두 개로 쪼개져 읽기 어렵다 (하루 칸으로 간다)
//   1시간 → 1분 · 4시간 → 5분 · 1일 → 30분 · 7일 → 3시간 · 30일 → 하루
const BUCKETS = [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, DAY];
const MAX_BUCKETS = 60;
export const bucketSizeOf = (window: TimeWindow) =>
    BUCKETS.find((size) => (window.to - window.from) / size <= MAX_BUCKETS) ?? DAY;

// 칸의 시작 (한국 시간 기준으로 맞춘다: 6시간 칸은 0·6·12·18시, 하루 칸은 0시에서 시작)
export const bucketStart = (ms: number, size: number) => Math.floor((ms + KST) / size) * size - KST;
export const dayStart = (ms: number) => bucketStart(ms, DAY); // 그날(한국 시간) 0시

// ---------------------------------------------------------------- 가로 눈금

// 눈금 간격 후보. 눈금 사이가 minGapPx 이상 벌어지는 가장 작은 것을 쓴다 (막대 수와 상관없이 '보기 좋은 시각'에 찍는다)
const TICKS = [
    MINUTE,
    2 * MINUTE,
    5 * MINUTE,
    10 * MINUTE,
    15 * MINUTE,
    30 * MINUTE,
    HOUR,
    2 * HOUR,
    3 * HOUR,
    6 * HOUR,
    12 * HOUR,
    DAY,
    2 * DAY,
    5 * DAY,
    7 * DAY,
];

export interface Tick {
    at: number;
    label: string;
    isDate: boolean; // 날짜 눈금 (한국 시간 0시). 굵게 그린다
}

// from~to 사이의 눈금. 한국 시간 0시에 걸리는 눈금은 날짜(9/24), 나머지는 시각(06:00)
export function ticksOf(from: number, to: number, widthPx: number, minGapPx = 72): Tick[] {
    const span = to - from;
    const interval = TICKS.find((step) => (step / span) * widthPx >= minGapPx) ?? 7 * DAY;
    const ticks: Tick[] = [];
    for (let at = bucketStart(from, interval); at <= to; at += interval) {
        if (at < from) continue;
        const p = kstParts(at);
        const isDate = p.hh === '00' && p.mm === '00';
        ticks.push({ at, label: isDate ? `${p.month}/${p.day}` : `${p.hh}:${p.mm}`, isDate });
    }
    return ticks;
}
