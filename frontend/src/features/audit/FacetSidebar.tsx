// 감사 로그 왼쪽의 거르기 목록 (Datadog Audit Trail의 facet 목록을 따랐다).
//   ▾ 결과                 지우기
//     ☑ 성공          120   [만]      ← 체크: 고르기·풀기, [만]: 이 값만 고르기 (마우스를 올리면 보인다)
//     ☐ 실패           12
//   ▾ 요청자
//     … 6개까지 보이고 '더 보기 (n)'
// 건수는 다른 거르기를 모두 적용하고 이 거르기만 뺀 기록에서 센다 (auditModel.facetValues)
import { useMemo, useState } from 'react';
import type { AuditRecord } from '@/types/audit';
import { FACETS, facetValues, toggleValue, type FacetDef, type Selection } from './auditModel';

const TOP_N = 6; // 값이 많은 거르기(요청자·도구)는 처음에 이만큼만 보인다

function FacetGroup({
    facet,
    records,
    selection,
    onChange,
}: {
    facet: FacetDef;
    records: AuditRecord[];
    selection: Selection;
    onChange: (next: Selection) => void;
}) {
    const [open, setOpen] = useState(true);
    const [showAll, setShowAll] = useState(false);
    const values = useMemo(() => facetValues(records, selection, facet), [records, selection, facet]);
    if (values.length === 0) return null; // 이 기간·조건에 값이 없는 거르기는 숨긴다

    const chosen = selection[facet.id]?.length ?? 0;
    // 처음 TOP_N개 + 그 밖에서 고른 값 (고른 값이 '더 보기' 뒤에 숨지 않게)
    const shown = showAll ? values : values.filter((item, index) => index < TOP_N || item.selected);
    const hidden = values.length - shown.length;
    const listId = `audit-facet-${facet.id}`;

    return (
        <div className="audit-facet">
            <div className="audit-facet-head">
                <button
                    type="button"
                    className="audit-facet-toggle"
                    aria-expanded={open}
                    aria-controls={listId}
                    onClick={() => setOpen((prev) => !prev)}
                >
                    <span className="audit-facet-caret" aria-hidden="true">
                        ▸
                    </span>
                    {facet.label}
                    {chosen ? <span className="audit-facet-chosen">{chosen}</span> : null}
                </button>
                {chosen ? (
                    <button
                        type="button"
                        className="audit-facet-clear"
                        onClick={() => onChange({ ...selection, [facet.id]: [] })}
                        aria-label={`${facet.label} 조건 지우기`}
                    >
                        지우기
                    </button>
                ) : null}
            </div>
            {open ? (
                <ul id={listId} className="audit-facet-values">
                    {shown.map((item) => (
                        <li key={item.value} className={`audit-facet-value${item.count === 0 ? ' is-empty' : ''}`}>
                            <label title={item.label}>
                                <input
                                    type="checkbox"
                                    checked={item.selected}
                                    onChange={() => onChange(toggleValue(selection, facet.id, item.value))}
                                />
                                <span className="audit-facet-name">{item.label}</span>
                                <span className="audit-facet-count">{item.count.toLocaleString()}</span>
                            </label>
                            <button
                                type="button"
                                className="audit-facet-only"
                                onClick={() => onChange({ ...selection, [facet.id]: [item.value] })}
                                aria-label={`${item.label}만 보기`}
                                title="이 값만 보기"
                            >
                                만
                            </button>
                        </li>
                    ))}
                    {hidden > 0 || (showAll && values.length > TOP_N) ? (
                        <li>
                            <button type="button" className="audit-facet-more" onClick={() => setShowAll((prev) => !prev)}>
                                {showAll ? '접기' : `더 보기 (${hidden})`}
                            </button>
                        </li>
                    ) : null}
                </ul>
            ) : null}
        </div>
    );
}

export function FacetSidebar({
    records,
    selection,
    onChange,
}: {
    records: AuditRecord[];
    selection: Selection;
    onChange: (next: Selection) => void;
}) {
    return (
        <nav className="audit-facets" aria-label="거르기">
            {FACETS.map((facet) => (
                <FacetGroup key={facet.id} facet={facet} records={records} selection={selection} onChange={onChange} />
            ))}
        </nav>
    );
}
