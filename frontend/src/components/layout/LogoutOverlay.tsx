import { LoadingCard } from '@/components/LoadingCard';

// 로그아웃 중: 화면 전체를 어둡게 덮고 가운데에 기다림 카드를 띄운다
export function LogoutOverlay() {
    return (
        <div className="logout-overlay">
            <LoadingCard text="로그아웃 중입니다..." />
        </div>
    );
}
