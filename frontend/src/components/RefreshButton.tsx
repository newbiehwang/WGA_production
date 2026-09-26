// 새로 고침 버튼 (아이콘만). 글자 대신 도는 화살표를 보이고, 화면 읽기 프로그램에는 aria-label로 알린다.
// 불러오는 동안에는 아이콘이 돌고 버튼이 꺼진다 (움직임을 줄이는 설정이면 돌지 않는다, panel.css)
export function RefreshButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
    return (
        <button
            type="button"
            className={`icon-button refresh-button${loading ? ' is-loading' : ''}`}
            onClick={onClick}
            disabled={loading}
            aria-label="새로 고침"
            title="새로 고침"
        >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                <path
                    d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        </button>
    );
}
