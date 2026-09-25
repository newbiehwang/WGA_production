export function LogoutOverlay() {
    return (
        <div className="logout-overlay" role="status" aria-live="polite">
            <div className="logout-overlay-card">
                <div className="logout-spinner" aria-hidden="true" />
                <p className="logout-overlay-text">로그아웃 중입니다...</p>
            </div>
        </div>
    );
}
