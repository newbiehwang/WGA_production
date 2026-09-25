import type { AuthUser } from '@/auth/authClient';

// AXPI의 프로필 메뉴에서 쓰지 않는 항목(프로필·설정)은 뺐다. 예전 '대시보드' 화면의 사용자 정보가 여기로 왔다
export function ProfileDropdown({
    onLogout,
    user,
    avatarLabel,
    isLoggingOut,
}: {
    onLogout: () => void;
    user: AuthUser;
    avatarLabel: string;
    isLoggingOut: boolean;
}) {
    return (
        <div className="profile-dropdown" id="profile-dropdown" role="menu">
            <div className="profile-dropdown-summary">
                <div className="summary-avatar" aria-hidden="true">
                    <span>{avatarLabel}</span>
                </div>
                <div className="summary-meta">
                    <p className="summary-name">{user.displayName}</p>
                    <p className="summary-email">{user.email}</p>
                </div>
            </div>

            <div className="profile-dropdown-divider" />

            <button
                className="profile-dropdown-item is-danger"
                type="button"
                role="menuitem"
                onClick={onLogout}
                disabled={isLoggingOut}
            >
                <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
                    <path d="M10 4a1 1 0 0 1 0 2H6v12h4a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5Zm5.3 3.3a1 1 0 0 1 1.4 0l4.3 4.3a1 1 0 0 1 0 1.4l-4.3 4.3a1 1 0 0 1-1.4-1.4l2.6-2.6H9a1 1 0 1 1 0-2h8.9l-2.6-2.6a1 1 0 0 1 0-1.4Z" />
                </svg>
                <span>{isLoggingOut ? '로그아웃 중...' : '로그아웃'}</span>
            </button>
        </div>
    );
}
