// 감사 로그의 조건(기간·거르기·검색어)을 주소에 담는다: 같은 화면을 링크로 나누고, 새로 고쳐도 조건이 남는다.
//   /audit?range=1d&result=error&requester=7c1e9a52-kim,slack:U04ABCDE
//   /audit?from=2026-09-20T05:00:00.000Z&to=2026-09-20T17:00:00.000Z     ← 직접 정한 구간 (UTC)
//   /audit?q=i-0428%20실패                                                  ← 검색어
//   /audit?group=requester                                                  ← 막대그래프 그룹 기준 (기본: 결과)
// 기본값(최근 7일, 거르기·검색어 없음)은 주소에 적지 않는다. 이 화면이 모르는 값(mock-role 등)은 그대로 둔다
import { FACETS, GROUP_OPTIONS, type FacetId, type GroupBy, type Selection } from './auditModel';
import { DEFAULT_PERIOD, PRESETS, isPreset, type Period } from './timeWindow';

const FACET_IDS = FACETS.map((facet) => facet.id);
const OWN_KEYS = ['range', 'from', 'to', 'q', 'group']; // 기간·검색어·그룹 기준 (거르기는 FACET_IDS)

export function readUrl(params: URLSearchParams): {
    period: Period;
    selection: Selection;
    query: string;
    groupBy: GroupBy;
} {
    let period: Period = DEFAULT_PERIOD;
    const range = params.get('range');
    const from = Date.parse(params.get('from') ?? '');
    const to = Date.parse(params.get('to') ?? '');
    if (range && PRESETS.some((preset) => preset.id === range)) period = { preset: range as (typeof PRESETS)[number]['id'] };
    else if (!Number.isNaN(from) && !Number.isNaN(to) && from < to) period = { from, to };

    const selection: Selection = {};
    for (const id of FACET_IDS) {
        const values = (params.get(id) ?? '').split(',').filter(Boolean);
        if (values.length) selection[id as FacetId] = values;
    }
    const group = params.get('group');
    const groupBy = GROUP_OPTIONS.find((option) => option.value === group)?.value ?? 'result';
    return { period, selection, query: params.get('q') ?? '', groupBy };
}

export function writeUrl(
    current: URLSearchParams,
    period: Period,
    selection: Selection,
    query: string,
    groupBy: GroupBy,
): URLSearchParams {
    const next = new URLSearchParams(current);
    for (const key of [...OWN_KEYS, ...FACET_IDS]) next.delete(key);
    if (isPreset(period)) {
        if (period.preset !== (DEFAULT_PERIOD as { preset: string }).preset) next.set('range', period.preset);
    } else {
        next.set('from', new Date(period.from).toISOString());
        next.set('to', new Date(period.to).toISOString());
    }
    for (const id of FACET_IDS) {
        const values = selection[id as FacetId];
        if (values?.length) next.set(id, values.join(','));
    }
    if (query.trim()) next.set('q', query.trim());
    if (groupBy !== 'result') next.set('group', groupBy);
    return next;
}
