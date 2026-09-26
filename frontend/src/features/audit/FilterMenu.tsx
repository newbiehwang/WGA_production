// 필터 버튼과 세부 선택 창. 거르기 목록(FacetSidebar: 종류·결과·층·요청자·도구·출처·표시)을 늘 옆에 두지 않고,
// '필터' 버튼을 누를 때만 아래에 연다. 고른 조건은 버튼 옆에 조각(칩)으로 보여, 창을 열지 않아도 무엇이 걸렸는지 안다.
//   [필터 2 ▾]  종류: 질문 ✕   결과: 실패 ✕
//   ┌ 필터 ─────────────────────────────── 조건 지우기 · 닫기 ┐
//   │ ▾ 종류        ▾ 요청자        ▾ 도구                    │   ← 여러 단으로. 값마다 건수, 체크로 고르고 풀기
//   │ ☑ 질문  119   ☐ demo…  101    ☐ 로그 분석  24           │
//   └───────────────────────────────────────────────────────┘
// - 값을 고르면 바로 목록·그래프에 적용된다 (적용 버튼 없음). 건수는 다른 조건을 적용한 채 센다
// - 바깥을 누르거나 Esc, '닫기'로 닫는다. '조건 지우기'는 거르기만 지운다 (기간·검색어는 그대로)
import { useEffect, useRef, useState } from 'react';
import type { AuditRecord } from '@/types/audit';
import { FACETS, activeCount, requesterOf, type FacetId, type Selection } from './auditModel';
import { FacetSidebar } from './FacetSidebar';

// 칩에 보일 값 이름 (요청자는 받은 기록에서 이메일·Slack 이름을 찾는다)
const chipLabel = (id: FacetId, value: string, records: AuditRecord[]) => {
    const facet = FACETS.find((f) => f.id === id);
    if (facet?.labelOf) return facet.labelOf(value);
    if (id === 'requester') {
        const record = records.find((r) => r.userId === value);
        return record ? requesterOf(record) : value;
    }
    return value;
};

export function FilterMenu({
    records,
    allRecords,
    selection,
    onChange,
    resetNo,
}: {
    records: AuditRecord[]; // 건수를 셀 기록 (기간·검색어를 적용한 것)
    allRecords: AuditRecord[]; // 칩의 요청자 이름을 찾을 기록 (받은 기록 전체)
    selection: Selection;
    onChange: (next: Selection) => void;
    resetNo: number; // 필터 초기화: 바뀌면 창을 닫고 거르기 목록의 접기·더 보기를 처음으로
}) {
    const [open, setOpen] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const count = activeCount(selection);

    useEffect(() => setOpen(false), [resetNo]);

    // 바깥을 누르거나 Esc를 누르면 닫는다 (Esc는 다른 창이 함께 닫히지 않게 여기서 끝낸다)
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!box.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setOpen(false);
            button.current?.focus();
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown, true);
        };
    }, [open]);

    const chips = FACETS.flatMap((facet) =>
        (selection[facet.id] ?? []).map((value) => ({ id: facet.id, facetLabel: facet.label, value })),
    );

    return (
        <div className="audit-filter-menu" ref={box}>
            <button
                ref={button}
                type="button"
                className={`audit-filter-button${open ? ' is-open' : ''}${count ? ' is-active' : ''}`}
                aria-expanded={open}
                aria-controls="audit-filter-panel"
                onClick={() => setOpen((prev) => !prev)}
            >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
                    <path d="M4 6h16M7 12h10M10 18h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                필터
                {count ? <span className="audit-filter-count">{count}</span> : null}
                <span className="audit-filter-caret" aria-hidden="true">
                    ▾
                </span>
            </button>

            {chips.length ? (
                <ul className="audit-filter-chips" aria-label="걸린 필터">
                    {chips.map((chip) => {
                        const label = chipLabel(chip.id, chip.value, allRecords);
                        return (
                            <li key={`${chip.id}:${chip.value}`}>
                                <span className="audit-filter-chip-facet">{chip.facetLabel}:</span>
                                <span className="audit-filter-chip-value" title={label}>
                                    {label}
                                </span>
                                <button
                                    type="button"
                                    onClick={() =>
                                        onChange({
                                            ...selection,
                                            [chip.id]: (selection[chip.id] ?? []).filter((v) => v !== chip.value),
                                        })
                                    }
                                    aria-label={`${chip.facetLabel} ${label} 조건 빼기`}
                                >
                                    <svg viewBox="0 0 14 14" width="9" height="9" aria-hidden="true" focusable="false">
                                        <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                    </svg>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            ) : null}

            {open ? (
                <div id="audit-filter-panel" className="audit-filter-panel" role="dialog" aria-label="필터 세부 선택">
                    <div className="audit-filter-panel-head">
                        <strong>필터</strong>
                        <div>
                            <button type="button" onClick={() => onChange({})} disabled={!count}>
                                조건 지우기
                            </button>
                            <button type="button" onClick={() => setOpen(false)}>
                                닫기
                            </button>
                        </div>
                    </div>
                    <FacetSidebar key={resetNo} records={records} selection={selection} onChange={onChange} />
                </div>
            ) : null}
        </div>
    );
}
