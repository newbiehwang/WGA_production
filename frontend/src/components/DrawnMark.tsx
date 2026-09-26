// 그려지는 원 표시: 옅은 고리 위에 진한 호가 한 바퀴 그려지고, 이어서 안쪽 표시(체크·!·✕·–)가 그려진다.
// 기다림 카드(LoadingCard)의 도는 원과 같은 굵기·색이라, 기다림이 끝나고 결과가 나온 느낌으로 이어진다.
//   ( ✓ ) check  성공 (파랑)          ( ! ) alert  실패 (빨강)
//   ( ✕ ) cross  거절 (회색)          ( – ) dash   시간 지남 등 (회색)
//   ( ◜ ) busy   진행 중: 호가 계속 돈다 (안쪽 표시 없음)
// 쓰는 곳: 알림(Toast, 28px), 끝난 승인 카드의 한 줄(ApprovalCard, 작게)
// 크기는 size로 바꾼다 (viewBox가 28이라 선 굵기도 같은 비율로 준다). 모양·색은 components/panel.css의 .drawn-mark
export type DrawnMarkKind = 'check' | 'alert' | 'cross' | 'dash' | 'busy';

const MARK_PATHS: Record<Exclude<DrawnMarkKind, 'busy'>, string> = {
    check: 'M8.6 14.4l3.6 3.6 7.2-7.6',
    alert: 'M14 8.2v7.2M14 19.6v.1', // 세로 막대와 점
    cross: 'M10.2 10.2l7.6 7.6M17.8 10.2l-7.6 7.6',
    dash: 'M9.6 14h8.8',
};

export function DrawnMark({ kind, size = 28, className = '' }: { kind: DrawnMarkKind; size?: number; className?: string }) {
    return (
        <svg
            className={`drawn-mark is-${kind}${className ? ` ${className}` : ''}`}
            viewBox="0 0 28 28"
            width={size}
            height={size}
            aria-hidden="true"
            focusable="false"
        >
            <circle className="drawn-mark-ring" cx="14" cy="14" r="12.5" />
            <circle className="drawn-mark-arc" cx="14" cy="14" r="12.5" pathLength={100} />
            {kind === 'busy' ? null : <path className="drawn-mark-sign" d={MARK_PATHS[kind]} pathLength={100} />}
        </svg>
    );
}
