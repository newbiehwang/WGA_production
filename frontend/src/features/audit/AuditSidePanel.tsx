// 기록 한 건을 자세히 보는 옆 패널 (Datadog Audit Trail처럼 오른쪽에서 밀려 나온다).
//   [↑][↓] 3 / 132                        [✕]
//   EC2 인스턴스 중지                           ← 도구·종류
//   2026. 9. 26. 오후 7:53:36 · 요청자 · 승인 요청 · 의심 뒤 요청
//   ───────────────────────────────
//   항목 표 (층·변경 내용·실행될 값·작업 ID…) · 층별로 따져 보기     ← 본문만 스크롤
//
// - 목록을 가리지 않는다(배경을 어둡게 하지 않는다). 목록의 다른 행을 누르면 그 기록으로 바뀐다
// - ↑/↓(또는 k/j)로 거른 목록의 앞뒤 기록으로 옮긴다. Esc·✕로 닫는다. 입력칸에 글을 쓰는 중에는 키를 가로채지 않는다
// - 열릴 때 패널에 포커스를 두고, 닫으면 부르는 쪽이 그 기록의 행으로 포커스를 돌려준다
// - 패널(plan-panel)은 등장 효과로 transform이 남아 있어 그 안의 position: fixed가 화면이 아니라 패널 기준이 된다.
//   그래서 document.body에 그린다
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AuditRecord } from '@/types/audit';
import { formatKoreanDateTimeSeconds } from '@/utils/formatters';
import { Details, Flags, KindLabel, ResultBadge } from './AuditDetails';
import { keyOf, requesterOf, timeOf } from './auditModel';

const CLOSE_MS = 160; // 닫히는 효과 시간 (audit.css의 audit-side-out)

const isTyping = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function AuditSidePanel({
    record,
    index,
    total,
    onMove,
    onClose,
}: {
    record: AuditRecord;
    index: number; // 거른 목록 안의 자리 (0부터)
    total: number;
    onMove: (step: -1 | 1) => void;
    onClose: () => void;
}) {
    const [isClosing, setIsClosing] = useState(false);
    const panel = useRef<HTMLElement>(null);
    const body = useRef<HTMLDivElement>(null);
    const key = keyOf(record);

    const close = () => {
        if (isClosing) return;
        setIsClosing(true);
        window.setTimeout(onClose, CLOSE_MS);
    };

    useEffect(() => {
        panel.current?.focus();
    }, []);

    // 다른 기록으로 바뀌면 본문을 맨 위부터 보인다
    useEffect(() => {
        body.current?.scrollTo({ top: 0 });
    }, [key]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
            if (event.key === 'Escape') {
                close();
                return;
            }
            if (isTyping(event.target)) return;
            if (event.key === 'ArrowUp' || event.key === 'k') {
                event.preventDefault(); // 화면이 스크롤되지 않게
                onMove(-1);
            } else if (event.key === 'ArrowDown' || event.key === 'j') {
                event.preventDefault();
                onMove(1);
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    });

    return createPortal(
        <aside
            ref={panel}
            tabIndex={-1}
            className={`audit-side-panel${isClosing ? ' is-closing' : ''}`}
            role="dialog"
            aria-modal="false"
            aria-labelledby="audit-side-title"
        >
            <div className="audit-side-head">
                <div className="audit-side-bar">
                    <div className="audit-side-nav">
                        <button
                            type="button"
                            className="icon-button audit-side-step"
                            onClick={() => onMove(-1)}
                            disabled={index <= 0}
                            aria-label="이전 기록 (↑)"
                            title="이전 기록 (↑)"
                        >
                            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                                <path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </button>
                        <button
                            type="button"
                            className="icon-button audit-side-step"
                            onClick={() => onMove(1)}
                            disabled={index >= total - 1}
                            aria-label="다음 기록 (↓)"
                            title="다음 기록 (↓)"
                        >
                            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                                <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </button>
                        <span className="audit-side-position">
                            {(index + 1).toLocaleString()} / {total.toLocaleString()}
                        </span>
                    </div>
                    <button type="button" className="icon-button audit-side-step" onClick={close} aria-label="닫기 (Esc)" title="닫기 (Esc)">
                        <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true" focusable="false">
                            <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                    </button>
                </div>
                <h2 id="audit-side-title" className="audit-side-title">
                    <KindLabel record={record} />
                </h2>
                <div className="audit-detail-meta">
                    <span>{formatKoreanDateTimeSeconds(timeOf(record))}</span>
                    <span title={record.userId}>{requesterOf(record)}</span>
                    <ResultBadge record={record} />
                    <Flags record={record} />
                </div>
            </div>
            <div ref={body} className="audit-side-body">
                {/* 기록이 바뀌면 역추적을 닫은 상태로 새로 그린다 */}
                <Details key={key} record={record} />
            </div>
        </aside>,
        document.body,
    );
}
