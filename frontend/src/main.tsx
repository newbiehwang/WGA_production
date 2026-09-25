import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { setupHttp } from './api/http';
import { configureAuth } from './auth/authClient';
import './styles.css';

// mock 모드(npm run dev:mock)에서는 백엔드 대신 가짜 API로 응답하고, Cognito 없이 로그인된다.
// 조건이 빌드할 때 정해지므로 배포용 빌드에는 가짜 API 코드가 들어가지 않는다.
const start = async () => {
    setupHttp();
    configureAuth();
    if (import.meta.env.MODE === 'mock') {
        const { installMockApi } = await import('./mock/api');
        installMockApi();
    }
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
        <React.StrictMode>
            {/* React Router v7 동작을 미리 켠다 (켜지 않으면 콘솔에 경고가 나온다) */}
            <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <App />
            </BrowserRouter>
        </React.StrictMode>,
    );
};

start();
