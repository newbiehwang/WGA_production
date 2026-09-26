// 기다리는 동안 보이는 카드 (도는 원 + 굵은 한 줄). 로그아웃 중 화면과 목록을 불러오는 동안(감사 로그·사용자 관리)이
// 같은 모양을 쓴다. 화면 읽기 프로그램에는 role="status"로 글자를 한 번 알린다 (원은 aria-hidden)
import { useEffect, useRef, useState } from 'react';

export function LoadingCard({ text }: { text: string }) {
    return (
        <div className="loading-card" role="status" aria-live="polite">
            <div className="loading-card-spinner" aria-hidden="true" />
            <p className="loading-card-text">{text}</p>
        </div>
    );
}

// 기다림 카드를 보이는 가장 짧은 시간. 응답이 빨라도 카드가 번쩍 나타났다 사라지지 않게 한다
const MIN_VISIBLE_MS = 1000;

// 불러오기(active)가 끝나도, 카드가 나타난 지 minMs가 지나기 전이면 그때까지 true를 돌려준다.
// 다시 불러오기가 시작되면(active) 바로 true. 카드가 떠 있는 동안 다시 시작되면 처음 나타난 때를 그대로 쓴다
export function useMinimumVisible(active: boolean, minMs = MIN_VISIBLE_MS): boolean {
    const [visible, setVisible] = useState(active);
    const shownAt = useRef(active ? Date.now() : 0);
    useEffect(() => {
        if (active) {
            if (!visible) {
                shownAt.current = Date.now();
                setVisible(true);
            }
            return;
        }
        if (!visible) return;
        const left = minMs - (Date.now() - shownAt.current);
        if (left <= 0) {
            setVisible(false);
            return;
        }
        const timer = window.setTimeout(() => setVisible(false), left);
        return () => window.clearTimeout(timer);
    }, [active, visible, minMs]);
    return active || visible;
}
