// 확인받는 창 (AXPI의 추진계획서 삭제 확인창). 삭제 확인과 이름 바꾸기에 쓴다
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ConfirmDialog({
    label,
    message,
    confirmText,
    tone = 'danger',
    busy = false,
    error = '',
    onConfirm,
    onCancel,
}: {
    label: string; // 화면 읽기 프로그램용 이름
    message: ReactNode;
    confirmText: string;
    tone?: 'danger' | 'primary'; // 삭제처럼 되돌릴 수 없으면 danger(빨강), 이름 바꾸기 같은 일반 작업은 primary
    busy?: boolean;
    error?: string;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return createPortal(
        <div className="confirm-delete-overlay" role="presentation" onClick={() => !busy && onCancel()}>
            <section
                className="confirm-delete-card"
                role="dialog"
                aria-modal="true"
                aria-label={label}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="confirm-delete-message">{message}</div>
                {error ? <p className="confirm-delete-error">{error}</p> : null}
                <div className="confirm-delete-actions">
                    <button type="button" className="confirm-delete-cancel-btn" disabled={busy} onClick={onCancel}>
                        취소
                    </button>
                    <button type="button" className={`confirm-delete-btn${tone === 'primary' ? ' is-primary' : ''}`} disabled={busy} onClick={onConfirm}>
                        {busy ? '처리 중...' : confirmText}
                    </button>
                </div>
            </section>
        </div>,
        document.body,
    );
}
