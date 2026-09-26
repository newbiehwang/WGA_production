// 대화 목록 팝업창. 모양은 AXPI의 추진계획서 생성 팝업창(create-plan-model)을 그대로 쓴다:
// 오른쪽 위 ✕, 큰 제목, 가운데 내용, 아래 오른쪽 버튼 (설명 문단은 두지 않는다). 닫을 때는 접히는 효과를 보여 준 뒤 사라진다.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useChatStore } from '@/stores/chatStore';
import { SessionList } from './SessionList';

const CLOSE_MS = 180; // AXPI closeWithAnimation과 같은 시간 (model-overlay-out·model-sheet-out)

export function SessionListModal({
    onClose,
    onSelect,
    onNewChat,
}: {
    onClose: () => void;
    onSelect: (sessionId: string) => void; // 대화를 고르면 부른다 (옮기기 확인은 부르는 쪽이 한다)
    onNewChat: () => void;
}) {
    const waiting = useChatStore((s) => s.waitingForResponse);
    const [isClosing, setIsClosing] = useState(false);

    const close = (after?: () => void) => {
        if (isClosing) return;
        setIsClosing(true);
        window.setTimeout(() => {
            onClose();
            after?.();
        }, CLOSE_MS);
    };

    // Esc로 닫는다. 팝업 위에 확인창(이름 바꾸기·삭제)이 떠 있으면 그 창이 먼저 닫힌다
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !document.querySelector('.confirm-delete-overlay')) close();
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
                className="create-plan-model session-list-model"
                role="dialog"
                aria-modal="true"
                aria-label="대화 목록"
                onClick={(event) => event.stopPropagation()}
            >
                <button className="vdt-model-close" type="button" onClick={() => close()} aria-label="닫기">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                </button>
                <div className="create-plan-expanded-model-body">
                    <div className="session-list-page">
                        <h3 className="create-plan-step-heading">대화 목록</h3>
                        <SessionList
                            onSelect={(sessionId) => close(() => onSelect(sessionId))}
                            actions={
                                <button
                                    className="create-plan-wizard-button is-primary"
                                    type="button"
                                    disabled={waiting}
                                    onClick={() => close(onNewChat)}
                                >
                                    + 새 대화
                                </button>
                            }
                        />
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
}
