// 상태 변경 알림 (토스트). 흰 패널(plan-panel)의 위쪽 가운데에 작은 상자로 떴다가 잠시 뒤 사라진다.
//             ┌──────────────────────────────────────┐
//             │ ✓  kim@example.com: 정지했습니다.       ✕ │     ← 성공은 파란 아이콘, 실패는 빨간 아이콘
//             └──────────────────────────────────────┘
// - 패널 안에 둔다 (plan-panel이 position: relative라 그 위쪽 가운데에 맞는다)
// - 성공은 SHOW_MS 뒤, 실패는 조금 더 오래(ERROR_SHOW_MS) 보인 뒤 사라진다. 마우스를 올리면 사라지지 않고 기다린다. ✕로 바로 닫는다
// - 새 알림이 오면 앞 알림을 바로 바꾼다 (id가 바뀌면 처음부터 다시 나타난다)
// - 화면 읽기 프로그램에는 성공은 status(공손히), 실패는 alert(바로)로 알린다
import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastTone = 'success' | 'error';
export interface ToastMessage {
    id: number;
    tone: ToastTone;
    text: string;
}

const SHOW_MS = 3200;
const ERROR_SHOW_MS = 5200;
const LEAVE_MS = 180; // 사라지는 효과 시간

// 알림 하나를 들고 있는 상태. show(tone, text)로 띄우고, 컴포넌트가 끝나면 clear
export function useToast() {
    const [toast, setToast] = useState<ToastMessage | null>(null);
    const nextId = useRef(0);
    const show = useCallback((tone: ToastTone, text: string) => {
        nextId.current += 1;
        setToast({ id: nextId.current, tone, text });
    }, []);
    const clear = useCallback(() => setToast(null), []);
    return { toast, show, clear };
}

export function Toast({ toast, onDone }: { toast: ToastMessage | null; onDone: () => void }) {
    const [leaving, setLeaving] = useState(false);
    const [hovered, setHovered] = useState(false);

    // 새 알림이면 처음부터
    useEffect(() => setLeaving(false), [toast?.id]);

    // 보이는 시간이 지나면 사라지는 효과 → 끝나면 onDone (마우스를 올린 동안은 기다린다)
    useEffect(() => {
        if (!toast || hovered) return;
        const timer = window.setTimeout(() => setLeaving(true), toast.tone === 'error' ? ERROR_SHOW_MS : SHOW_MS);
        return () => window.clearTimeout(timer);
    }, [toast, hovered]);

    useEffect(() => {
        if (!leaving) return;
        const timer = window.setTimeout(onDone, LEAVE_MS);
        return () => window.clearTimeout(timer);
    }, [leaving, onDone]);

    if (!toast) return null;
    return (
        <div
            key={toast.id}
            className={`panel-toast is-${toast.tone}${leaving ? ' is-leaving' : ''}`}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            <span className="panel-toast-icon" aria-hidden="true">
                {toast.tone === 'error' ? (
                    <svg viewBox="0 0 16 16" width="10" height="10">
                        <path d="M8 3.5v5.2M8 11.6v.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                    </svg>
                ) : (
                    <svg viewBox="0 0 16 16" width="10" height="10">
                        <path d="M3.5 8.4l3 3 6-6.6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                )}
            </span>
            <span className="panel-toast-text">{toast.text}</span>
            <button type="button" className="panel-toast-close" onClick={() => setLeaving(true)} aria-label="알림 닫기">
                <svg viewBox="0 0 14 14" width="9" height="9" aria-hidden="true">
                    <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
            </button>
        </div>
    );
}
