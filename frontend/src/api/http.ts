// API 요청 공통 설정 (예전 main.ts의 axios 설정을 옮겼다).
// 앱의 모든 요청은 전역 axios를 쓴다: mock 모드(mock/api.ts)가 이 axios의 adapter를 바꿔 끼워 대신 응답한다.
import axios from 'axios';
import { idToken } from '@/auth/authClient';

export const API_BASE = import.meta.env.VITE_API_DEST || 'http://localhost:8000';

// 인증 없이 열려 있는 경로: Authorization 헤더를 붙이면 OPTIONS 메서드가 없는 경로의 CORS preflight가 실패한다
const PUBLIC_API_PATHS = ['/health'];

// API Gateway(Cognito Authorizer)로 가는 요청에만 ID 토큰을 붙인다 (Cognito 같은 외부 요청에는 붙이지 않음)
const isApiRequest = (url = '') =>
    (url.startsWith(API_BASE) || !/^https?:\/\//.test(url)) &&
    !PUBLIC_API_PATHS.some((path) => url.split('?')[0].endsWith(path));

let onUnauthorized: () => void = () => {};

// 401(토큰이 없거나 만료되어 갱신도 실패)이면 로그인 화면으로 보낸다. App이 등록한다
export function setUnauthorizedHandler(handler: () => void) {
    onUnauthorized = handler;
}

export function setupHttp() {
    axios.defaults.baseURL = API_BASE;
    axios.defaults.withCredentials = true;

    axios.interceptors.request.use(async (config) => {
        if (!isApiRequest(config.url)) return config;
        // Amplify가 만료된 토큰을 refresh token으로 알아서 갱신해 준다
        const token = await idToken();
        if (token) config.headers.Authorization = token;
        return config;
    });

    axios.interceptors.response.use(
        (response) => response,
        (error) => {
            if (error?.response?.status === 401) onUnauthorized();
            return Promise.reject(error);
        },
    );
}
