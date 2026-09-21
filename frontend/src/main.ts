import './assets/main.css';
import './assets/base.css';

import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from './App.vue';
import router from './router';
import axios from 'axios';
import markdownDirective from './directives/markdown-directive';
import { useAuthStore } from './stores/auth';

const app = createApp(App);

const pinia = createPinia();
app.use(pinia);

app.use(router);

app.directive('markdown', markdownDirective);

axios.defaults.withCredentials = true;

const apiUrl = import.meta.env.VITE_API_DEST || '/api';
axios.defaults.baseURL = apiUrl;

// API Gateway Cognito Authorizer로 보내는 요청에만 ID 토큰을 붙인다
// (Cognito 토큰 엔드포인트 등 외부 요청에는 붙이지 않음)
const apiDest = import.meta.env.VITE_API_DEST || 'http://localhost:8000';
// 인증 없이 열려 있는 경로: Authorization 헤더를 붙이면 OPTIONS 메서드가 없는 경로의 CORS preflight가 실패한다
const PUBLIC_API_PATHS = ['/health'];
const isApiRequest = (url = '') =>
    (url.startsWith(apiDest) || url.startsWith(apiUrl) || !/^https?:\/\//.test(url)) &&
    !PUBLIC_API_PATHS.some((path) => url.split('?')[0].endsWith(path));

axios.interceptors.request.use(
    async (config) => {
        if (!isApiRequest(config.url)) {
            return config;
        }

        const authStore = useAuthStore(pinia);
        if (authStore.tokens.idToken && !(await authStore.validateToken())) {
            // 만료된 ID 토큰은 refresh token으로 갱신 후 사용
            await authStore.refreshTokens();
        }
        if (authStore.tokens.idToken) {
            config.headers.Authorization = authStore.tokens.idToken;
        }

        return config;
    },
    (error) => {
        console.error('API 요청 오류:', error);
        return Promise.reject(error);
    },
);

axios.interceptors.response.use(
    (response) => {
        return response;
    },
    (error) => {
        if (error.response && error.response.status === 401) {
            router.push('/login');
        }

        console.error('API 응답 오류:', error);
        return Promise.reject(error);
    },
);

app.mount('#app');
