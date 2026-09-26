// 알림 (토스트): 상태 변경 결과, 경고, 오류를 모든 탭에서 같은 모양으로 띄운다.
// 모양은 기다림 카드(LoadingCard: 로그아웃 중·목록 불러오는 중)와 같은 카드이고, 자리는 흰 패널(plan-panel)의 위쪽 가운데다
// (가운데에 띄우면 내용을 가리고, 불러오는 중의 기다림 카드와 겹친다). 잠시 뒤 사라진다.
//              ┌─────────────────────────────┐
//              │            ( ✓ )             │   ← 기다림 카드의 도는 원 자리: 같은 크기의 원이 한 바퀴 그려지고 체크가 그려진다
//              │  lee@example.com: 정지했습니다. │      (실패는 빨간 원과 !)
//              └─────────────────────────────┘
// 쓰는 법
// - 앱 틀(App)이 ToastProvider로 감싸고, 각 탭의 패널 안에 <ToastHost />를 둔다 (plan-panel이 position: relative라 그 위쪽 가운데에 맞는다)
// - 띄우는 쪽은 어디서든 const { show } = useToast(); show('success' | 'error', '문구') (대화의 승인 카드처럼 깊은 곳도)
// 동작
// - 성공은 SHOW_MS 뒤, 실패는 조금 더 오래(ERROR_SHOW_MS) 보인 뒤 사라진다. 마우스를 올리면 사라지지 않고 기다린다.
//   카드를 누르면 바로 닫는다 (기다림 카드처럼 버튼을 두지 않는다)
// - 새 알림이 오면 앞 알림을 바로 바꾼다 (id가 바뀌면 처음부터 다시 나타난다). 탭을 옮기면 지운다 (앞 탭의 알림이 따라오지 않게)
// - 화면 읽기 프로그램에는 성공은 status(공손히), 실패는 alert(바로)로 알린다
// 입력 칸 옆의 확인 문구(기간 직접 입력, 초대 이메일, 로그인)와 내용 자리의 불러오기 실패 안내는 그 자리에 둔다 (알림이 아니다)
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

export type ToastTone = 'success' | 'error';
export interface ToastMessage {
    id: number;
    tone: ToastTone;
    text: string;
}

const SHOW_MS = 3200;
const ERROR_SHOW_MS = 5200;
const LEAVE_MS = 180; // 사라지는 효과 시간

interface ToastContextValue {
    toast: ToastMessage | null;
    show: (tone: ToastTone, text: string) => void;
    clear: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toast, setToast] = useState<ToastMessage | null>(null);
    const nextId = useRef(0);
    const show = useCallback((tone: ToastTone, text: string) => {
        nextId.current += 1;
        setToast({ id: nextId.current, tone, text });
    }, []);
    const clear = useCallback(() => setToast(null), []);

    // 탭을 옮기면 지운다
    const { pathname } = useLocation();
    useEffect(() => setToast(null), [pathname]);

    const value = useMemo(() => ({ toast, show, clear }), [toast, show, clear]);
    return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

// 알림 띄우기 (ToastProvider 밖에서 부르면 아무것도 하지 않는다: 로그인 화면 등)
export function useToast() {
    const context = useContext(ToastContext);
    const noop = useCallback(() => {}, []);
    return { show: context?.show ?? noop, clear: context?.clear ?? noop };
}

// 각 탭의 패널 안에 둔다
export function ToastHost() {
    const context = useContext(ToastContext);
    if (!context) return null;
    return <Toast toast={context.toast} onDone={context.clear} />;
}

function Toast({ toast, onDone }: { toast: ToastMessage | null; onDone: () => void }) {
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
            title="누르면 닫힙니다"
            onClick={() => setLeaving(true)}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            {/* 기다림 카드의 원(28px, 테두리 3px)과 같은 자리·크기. 원이 한 바퀴 그려진 뒤 체크(또는 !)가 그려진다 */}
            <svg className="panel-toast-icon" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
                <circle className="panel-toast-ring" cx="14" cy="14" r="12.5" />
                <circle className="panel-toast-arc" cx="14" cy="14" r="12.5" pathLength={100} />
                {toast.tone === 'error' ? (
                    <path className="panel-toast-mark" d="M14 8.2v7.2M14 19.6v.1" pathLength={100} />
                ) : (
                    <path className="panel-toast-mark" d="M8.6 14.4l3.6 3.6 7.2-7.6" pathLength={100} />
                )}
            </svg>
            <p className="panel-toast-text">{toast.text}</p>
        </div>
    );
}
