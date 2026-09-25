// 위쪽 내비게이션: 로고 · 가운데 탭(홈, 대화) · 오른쪽 프로필 (AXPI Navigation.tsx)
import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import type { AuthUser } from '@/auth/authClient';
import { makeAvatarLabel } from '@/utils/formatters';
import { LogoMark } from './LogoMark';
import { ProfileAvatar } from './ProfileAvatar';
import { ProfileDropdown } from './ProfileDropdown';

const NAV_ITEMS = [
    { label: '홈', to: '/' },
    { label: '대화', to: '/chat' },
];

export function Navigation({
    user,
    onLogout,
    isLoggingOut,
}: {
    user: AuthUser;
    onLogout: () => void;
    isLoggingOut: boolean;
}) {
    const navigate = useNavigate();
    const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
    const profileActionsRef = useRef<HTMLDivElement>(null);
    const avatarLabel = makeAvatarLabel(user.displayName);

    // 메뉴 밖을 누르거나 Esc를 누르면 닫는다
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (!profileActionsRef.current?.contains(event.target as Node)) setIsProfileMenuOpen(false);
        };
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsProfileMenuOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, []);

    return (
        <header className="top-nav">
            <div className="nav-inner">
                <a
                    className="brand-link"
                    href="/"
                    aria-label="홈으로 이동"
                    onClick={(event) => {
                        event.preventDefault();
                        navigate('/');
                    }}
                >
                    <LogoMark />
                </a>
                <nav className="center-toolbar" aria-label="주요 메뉴">
                    {NAV_ITEMS.map((item) => (
                        <NavLink
                            key={item.to}
                            to={item.to}
                            end
                            className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}
                        >
                            {item.label}
                        </NavLink>
                    ))}
                </nav>
                <div className="profile-actions" ref={profileActionsRef}>
                    <ProfileAvatar
                        isOpen={isProfileMenuOpen}
                        onClick={() => setIsProfileMenuOpen((prev) => !prev)}
                        avatarLabel={avatarLabel}
                    />
                    {isProfileMenuOpen ? (
                        <ProfileDropdown
                            onLogout={() => {
                                setIsProfileMenuOpen(false);
                                onLogout();
                            }}
                            user={user}
                            avatarLabel={avatarLabel}
                            isLoggingOut={isLoggingOut}
                        />
                    ) : null}
                </div>
            </div>
        </header>
    );
}
