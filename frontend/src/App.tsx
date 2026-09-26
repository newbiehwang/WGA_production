// 앱 틀: 로그인하지 않았으면 로그인 화면, 했으면 위쪽 내비게이션 + 화면(홈 / 대화 / 감사 로그·사용자 관리는 관리자만)
import { useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { setUnauthorizedHandler } from './api/http';
import { isAdmin, isReturningFromLogin, onLoginResult } from './auth/authClient';
import { useAuthStore } from './auth/authStore';
import { LoginPage } from './components/layout/LoginPage';
import { LogoutOverlay } from './components/layout/LogoutOverlay';
import { Navigation } from './components/layout/Navigation';
import { AuditPage } from './features/audit/AuditPage';
import { ChatPage } from './features/chat/ChatPage';
import { HomePage } from './features/home/HomePage';
import { UsersPage } from './features/users/UsersPage';
import { useChatStore } from './stores/chatStore';

export default function App() {
    const status = useAuthStore((s) => s.status);
    const user = useAuthStore((s) => s.user);
    const isLoggingOut = useAuthStore((s) => s.isLoggingOut);
    const refresh = useAuthStore((s) => s.refresh);
    const navigate = useNavigate();
    const [loginError, setLoginError] = useState('');
    // useNavigate가 돌려주는 함수는 주소가 바뀔 때마다 새로 만들어진다 (React Router 선언형 모드).
    // 아래 로그인 처리가 navigate에 따라 다시 실행되면 탭을 옮길 때마다 구독을 새로 하므로, 최신 함수를 ref로 들고 쓴다
    const navigateRef = useRef(navigate);
    navigateRef.current = navigate;

    // 앱을 열 때 한 번만: 로그인 상태를 읽고, Cognito에서 돌아왔으면 그 결과를 기다린다
    useEffect(() => {
        setUnauthorizedHandler(() => useAuthStore.getState().expire());

        // Cognito 로그인 페이지에서 /redirect?code=...로 돌아왔으면, Amplify가 code를 토큰으로 바꿀 때까지
        // 로딩을 보여 준다 (그 사이 세션을 읽으면 아직 비어 있어 로그인 화면이 잠깐 보인다)
        const returning = isReturningFromLogin();
        const fallback = returning ? window.setTimeout(() => refresh(), 15000) : undefined; // 결과가 끝내 안 오면
        const stop = onLoginResult((result) => {
            window.clearTimeout(fallback);
            if (!result.ok) setLoginError(result.message);
            refresh();
            navigateRef.current('/', { replace: true }); // /redirect 주소를 남기지 않는다
        });
        if (!returning) refresh();
        return () => {
            stop();
            window.clearTimeout(fallback);
        };
    }, [refresh]); // refresh는 스토어 함수라 바뀌지 않는다

    const handleLogout = async () => {
        useChatStore.getState().cancelRequest();
        await useAuthStore.getState().signOut();
        // 다른 사람이 로그인할 수 있으므로 앞 사람의 대화를 화면에 남기지 않는다
        useChatStore.setState({ sessions: [], currentSession: null, loaded: false, error: null });
    };

    if (status === 'loading') {
        return (
            <div className="app-loading" role="status">
                <div className="plan-inline-spinner" />
            </div>
        );
    }

    if (status === 'signedOut' || !user) return <LoginPage errorMessage={loginError} onSignedIn={refresh} />;

    return (
        <div className="app-shell">
            <Navigation user={user} onLogout={handleLogout} isLoggingOut={isLoggingOut} />
            <main className="main-content">
                <div className="main-tab-stage">
                    <Routes>
                        <Route path="/" element={<HomePage />} />
                        <Route path="/chat" element={<ChatPage />} />
                        {/* 관리자가 아니면 주소로 들어와도 홈으로 보낸다 (조회는 서버가 403으로 막는다) */}
                        <Route path="/audit" element={isAdmin(user) ? <AuditPage /> : <Navigate to="/" replace />} />
                        <Route path="/users" element={isAdmin(user) ? <UsersPage /> : <Navigate to="/" replace />} />
                        {/* 예전 주소(/start-chat, /dashboard, /login)와 로그인·로그아웃 뒤 돌아오는 /redirect는 홈으로 */}
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </div>
            </main>
            {isLoggingOut ? <LogoutOverlay /> : null}
        </div>
    );
}
