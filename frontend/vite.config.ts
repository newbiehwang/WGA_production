// vite.config.ts
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
    // deploy.sh가 만든 frontend/.env.local을 읽는다 (VITE_ 접두사가 없는 값도 읽도록 '')
    const env = loadEnv(mode, process.cwd(), '');

    return {
        plugins: [react()],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
            },
        },
        server: {
            port: 5173,
            // 배포된 API로 넘기는 프록시. mock 모드처럼 API 주소가 없으면 만들지 않는다
            proxy: env.API_DEST
                ? {
                      '/api': {
                          target: env.API_DEST,
                          changeOrigin: true,
                          rewrite: (p) => p.replace(/^\/api/, ''),
                          secure: false,
                      },
                  }
                : undefined,
        },
        define: {
            // 브라우저 번들에 넣을 값만 골라 넣는다. 비밀 값(AWS 키 등)은 넣지 않는다:
            // loadEnv(..., '')는 셸 환경 변수까지 읽으므로 배포자의 AWS 자격 증명이 포함될 수 있다.
            'import.meta.env.AWS_REGION': JSON.stringify(env.AWS_REGION),
            'import.meta.env.USER_POOL_ID': JSON.stringify(env.USER_POOL_ID),
            'import.meta.env.COGNITO_CLIENT_ID': JSON.stringify(env.COGNITO_CLIENT_ID),
            'import.meta.env.COGNITO_DOMAIN': JSON.stringify(env.COGNITO_DOMAIN),
        },
    };
});
