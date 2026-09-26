// 감사 로그의 기간 고르기: [1시간][4시간][1일][7일][30일][직접]
// '직접'을 누르면 아래에 시작·끝 시각(한국 시간) 입력이 열린다. 직접 정한 구간(막대그래프 드래그 포함)이면
// '직접' 자리에 그 구간이 보인다 (예: 9. 20. 14:00 ~ 9. 21. 02:00). 미리 정한 기간을 누르면 돌아간다
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
    MAX_DAYS,
    PRESETS,
    daySpan,
    formatWindow,
    fromInputValue,
    isPreset,
    toInputValue,
    type Period,
    type TimeWindow,
} from './timeWindow';

export function PeriodPicker({
    period,
    window,
    onChange,
}: {
    period: Period;
    window: TimeWindow;
    onChange: (period: Period) => void;
}) {
    const [open, setOpen] = useState(false);
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [error, setError] = useState<string | null>(null);
    const box = useRef<HTMLDivElement>(null);

    // 바깥을 누르거나 Esc를 누르면 닫는다
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!box.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault(); // 옆 패널이 함께 닫히지 않게
                setOpen(false);
            }
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown, true);
        };
    }, [open]);

    const openCustom = () => {
        setFrom(toInputValue(window.from));
        setTo(toInputValue(window.to));
        setError(null);
        setOpen((prev) => !prev);
    };

    const apply = (event: FormEvent) => {
        event.preventDefault();
        const start = fromInputValue(from);
        const end = fromInputValue(to);
        if (Number.isNaN(start) || Number.isNaN(end)) return setError('시작과 끝 시각을 모두 입력해 주세요.');
        if (start >= end) return setError('시작이 끝보다 앞이어야 합니다.');
        if (daySpan({ from: start, to: end }) > MAX_DAYS) return setError(`한 번에 ${MAX_DAYS}일까지 볼 수 있습니다.`);
        onChange({ from: start, to: end });
        setOpen(false);
    };

    const custom = !isPreset(period);
    return (
        <div className="audit-period" ref={box}>
            <div className="audit-segment" role="group" aria-label="기간">
                {PRESETS.map((preset) => {
                    const selected = !custom && period.preset === preset.id;
                    return (
                        <button
                            key={preset.id}
                            type="button"
                            className={`audit-segment-btn${selected ? ' is-active' : ''}`}
                            aria-pressed={selected}
                            onClick={() => {
                                setOpen(false);
                                onChange({ preset: preset.id });
                            }}
                        >
                            {preset.label}
                        </button>
                    );
                })}
                <button
                    type="button"
                    className={`audit-segment-btn${custom ? ' is-active' : ''}`}
                    aria-pressed={custom}
                    aria-expanded={open}
                    onClick={openCustom}
                >
                    {custom ? formatWindow(window) : '직접'}
                </button>
            </div>
            {open ? (
                <form className="audit-period-popover" onSubmit={apply} aria-label="기간 직접 정하기">
                    <label>
                        <span>시작</span>
                        <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
                    </label>
                    <label>
                        <span>끝</span>
                        <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
                    </label>
                    <p className="audit-period-note">한국 시간 · 한 번에 {MAX_DAYS}일까지</p>
                    {error ? (
                        <p className="audit-period-error" role="alert">
                            {error}
                        </p>
                    ) : null}
                    <div className="audit-period-actions">
                        <button type="button" className="plan-reload-button" onClick={() => setOpen(false)}>
                            취소
                        </button>
                        <button type="submit" className="plan-create-button">
                            적용
                        </button>
                    </div>
                </form>
            ) : null}
        </div>
    );
}
