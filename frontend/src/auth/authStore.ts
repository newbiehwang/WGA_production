// 로그인 상태 (앱 전체가 함께 쓴다)
import { create } from 'zustand';
import { currentUser, logout, type AuthUser } from './authClient';

interface AuthState {
    status: 'loading' | 'signedIn' | 'signedOut';
    user: AuthUser | null;
    isLoggingOut: boolean;
    refresh: () => Promise<void>; // Cognito 세션을 다시 읽는다 (앱 시작, 로그인 직후)
    signOut: () => Promise<void>;
    expire: () => Promise<void>; // API가 401을 돌려줬을 때: 저장된 토큰을 지우고 로그인 화면으로
}

export const useAuthStore = create<AuthState>((set) => ({
    status: 'loading',
    user: null,
    isLoggingOut: false,

    refresh: async () => {
        const user = await currentUser();
        set({ user, status: user ? 'signedIn' : 'signedOut' });
    },

    signOut: async () => {
        set({ isLoggingOut: true });
        try {
            await logout();
        } finally {
            set({ user: null, status: 'signedOut', isLoggingOut: false });
        }
    },

    expire: async () => {
        // 토큰을 남겨 두면 다시 로그인할 때 같은 토큰을 그대로 써서 또 401이 난다
        await logout().catch(() => {});
        set({ user: null, status: 'signedOut' });
    },
}));
