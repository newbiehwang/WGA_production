// 기록 한 건을 자세히 보는 팝업창. 모양과 여닫는 효과는 이 앱의 다른 팝업창(대화 목록, SessionListModal)과 같은
// create-plan-model이다: 화면을 어둡게 덮고 가운데에 뜬다, 오른쪽 위 ✕, 닫을 때 접히는 효과.
//   EC2 인스턴스 중지                                     ✕   ← 도구·종류
//   2026. 9. 26. 오후 7:53:36 · 요청자 · 승인 요청 · 의심 뒤 요청
//   [같은 질문의 기록] [같은 대화의 기록] [이 요청자만] [이 도구만]
//   ───────────────────────────────
//   항목 표 (층·변경 내용·실행될 값·작업 ID…) · 층별로 따져 보기     ← 본문만 스크롤
//
// - 키보드 ↑/↓(또는 k/j)로 거른 목록의 앞뒤 기록으로 옮긴다 (팝업창을 닫지 않고). Esc·✕·바깥 누르기로 닫는다
// - 이어 찾기 버튼(같은 질문·대화·작업의 기록, 이 요청자만·이 도구만)은 목록의 조건을 바꾸고 팝업창을 닫는다 (바뀐 목록을 보게)
// - 열릴 때 팝업창에 포커스를 두고, 닫으면 부르는 쪽이 그 기록의 행으로 포커스를 돌려준다
// - 패널(plan-panel)은 등장 효과로 transform이 남아 있어 그 안의 position: fixed가 화면이 아니라 패널 기준이 된다.
//   그래서 document.body에 그린다
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AuditRecord } from '@/types/audit';
import { formatKoreanDateTimeSeconds } from '@/utils/formatters';
import { Details, Flags, KindLabel, ResultBadge } from './AuditDetails';
import { keyOf, requesterOf, timeOf, toolLabelOf, type FacetId } from './auditModel';

const CLOSE_MS = 180; // 닫히는 효과 시간 (대화 목록 팝업창과 같다: model-overlay-out·model-sheet-out)

const isTyping = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function AuditDetailModal({
    record,
    onMove,
    onClose,
    onRelated,
    onFacet,
}: {
    record: AuditRecord;
    onMove: (step: -1 | 1) => void; // 앞뒤 기록 (거른 목록의 처음·끝이면 부르는 쪽이 무시한다)
    onClose: () => void;
    onRelated: (id: string) => void; // 이 ID가 든 기록을 모두 (검색어로)
    onFacet: (id: FacetId, value: string) => void; // 그 거르기를 이 값 하나로
}) {
    const [isClosing, setIsClosing] = useState(false);
    const dialog = useRef<HTMLDivElement>(null);
    const body = useRef<HTMLDivElement>(null);
    const key = keyOf(record);

    // after: 닫히는 효과가 끝난 뒤 할 일 (이어 찾기: 조건 바꾸기)
    const close = (after?: () => void) => {
        if (isClosing) return;
        setIsClosing(true);
        window.setTimeout(() => {
            after?.();
            onClose();
        }, CLOSE_MS);
    };

    useEffect(() => {
        dialog.current?.focus();
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
                event.preventDefault(); // 본문이 스크롤되지 않게
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
        <div
            className={`create-plan-model-overlay${isClosing ? ' is-closing' : ''}`}
            role="presentation"
            onClick={() => close()}
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
                <button className="vdt-model-close" type="button" onClick={() => close()} aria-label="닫기 (Esc)">
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
                    <div className="audit-detail-actions" role="group" aria-label="이 기록에서 이어 찾기">
                        {record.requestId ? (
                            <button type="button" onClick={() => close(() => onRelated(record.requestId!))}>
                                같은 질문의 기록
                            </button>
                        ) : null}
                        {record.sessionId ? (
                            <button type="button" onClick={() => close(() => onRelated(record.sessionId!))}>
                                같은 대화의 기록
                            </button>
                        ) : null}
                        {record.actionId ? (
                            <button type="button" onClick={() => close(() => onRelated(record.actionId!))}>
                                같은 작업의 기록
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={() => close(() => onFacet('requester', record.userId))}
                            title={requesterOf(record)}
                        >
                            이 요청자만
                        </button>
                        {record.tool ? (
                            <button
                                type="button"
                                onClick={() => close(() => onFacet('tool', record.tool!))}
                                title={toolLabelOf(record.tool)}
                            >
                                이 도구만
                            </button>
                        ) : null}
                    </div>
                </div>
                <div ref={body} className="audit-detail-body">
                    {/* 기록이 바뀌면 역추적을 닫은 상태로 새로 그린다 */}
                    <Details key={key} record={record} />
                </div>
            </div>
        </div>,
        document.body,
    );
}
