// vite.config.ts
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');

    return {
        plugins: [vue()],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
            },
        },
        server: {
            port: 5173,
            proxy: {
                '/api': {
                    target: env.API_DEST,
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/api/, ''),
                    secure: false,
                    ws: true,
                },
            },
        },
        define: {
            'import.meta.env.AWS_REGION': JSON.stringify(env.AWS_REGION),
            'import.meta.env.USER_POOL_ID': JSON.stringify(env.USER_POOL_ID),
            'import.meta.env.COGNITO_CLIENT_ID': JSON.stringify(env.COGNITO_CLIENT_ID),
            'import.meta.env.COGNITO_REDIRECT_URI': JSON.stringify(env.COGNITO_REDIRECT_URI),
            'import.meta.env.COGNITO_DOMAIN': JSON.stringify(env.COGNITO_DOMAIN),
            'import.meta.env.API_URL': JSON.stringify(env.API_URL),
            // 비밀 값(AWS 키, Cognito client secret)은 브라우저 번들에 넣지 않는다.
            // loadEnv(..., '')는 셸 환경 변수까지 읽으므로 배포자의 AWS 자격 증명이 포함될 수 있다.
            'import.meta.env.COGNITO_IDENTITY_POOL_ID': JSON.stringify(
                env.COGNITO_IDENTITY_POOL_ID,
            ),
            'import.meta.env.API_DEST': JSON.stringify(env.API_DEST),
        },
    };
});
