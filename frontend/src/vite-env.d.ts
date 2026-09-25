/// <reference types="vite/client" />

// vite.config.ts의 define이 넣어 주는 값 (deploy.sh가 만든 frontend/.env.local에서 읽는다)
interface ImportMetaEnv {
    readonly AWS_REGION?: string;
    readonly USER_POOL_ID?: string;
    readonly COGNITO_CLIENT_ID?: string;
    readonly VITE_API_DEST?: string;
}
