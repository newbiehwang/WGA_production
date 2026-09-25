export function ProfileAvatar({
    isOpen,
    onClick,
    avatarLabel,
}: {
    isOpen: boolean;
    onClick: () => void;
    avatarLabel: string;
}) {
    return (
        <button
            className={`profile-avatar${isOpen ? ' is-open' : ''}`}
            type="button"
            aria-label="사용자 프로필"
            aria-expanded={isOpen}
            aria-controls="profile-dropdown"
            onClick={onClick}
        >
            <span aria-hidden="true">{avatarLabel}</span>
        </button>
    );
}
