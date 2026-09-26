// 기다리는 동안 보이는 카드 (도는 원 + 굵은 한 줄). 로그아웃 중 화면과 목록을 불러오는 동안(감사 로그·사용자 관리)이
// 같은 모양을 쓴다. 화면 읽기 프로그램에는 role="status"로 글자를 한 번 알린다 (원은 aria-hidden)
export function LoadingCard({ text }: { text: string }) {
    return (
        <div className="loading-card" role="status" aria-live="polite">
            <div className="loading-card-spinner" aria-hidden="true" />
            <p className="loading-card-text">{text}</p>
        </div>
    );
}
