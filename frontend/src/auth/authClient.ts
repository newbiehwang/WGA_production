// Cognito 로그인 (앱 안의 로그인 화면에서 직접 한다).
//
// 예전에는 Cognito Hosted UI(Cognito 도메인의 로그인 페이지)로 보냈다가 /redirect로 돌아와 코드를 토큰으로 바꿨다.
// 지금은 Amplify Auth가 SRP 방식으로 비밀번호를 서버에 보내지 않고 로그인하고, 토큰 저장·갱신도 맡는다.
// (User Pool Client의 ExplicitAuthFlows에 ALLOW_USER_SRP_AUTH가 이미 켜져 있다: cloudformation/base.yaml)
//
// mock 모드(npm run dev:mock)에서는 Cognito 없이 아무 값으로나 로그인된다.
import { Amplify } from 'aws-amplify';
import {
    confirmResetPassword,
    confirmSignIn,
    confirmSignUp,
    fetchAuthSession,
    fetchUserAttributes,
    getCurrentUser,
    resendSignUpCode,
    resetPassword,
    signIn,
    signOut,
    signUp,
} from 'aws-amplify/auth';

export interface AuthUser {
    email: string;
    displayName: string; // 이름이 없으면 이메일 앞부분
}

// 로그인 다음에 해야 할 일. 화면(LoginPage)이 이 값에 따라 다음 입력 칸을 보여 준다
export type LoginStep =
    | 'done' // 로그인 끝
    | 'new-password' // 관리자가 만든 계정의 첫 로그인: 새 비밀번호를 정해야 한다
    | 'confirm-sign-up' // 가입했지만 이메일 인증을 하지 않았다
    | 'reset-password'; // 관리자가 비밀번호 재설정을 요구했다

const MOCK = import.meta.env.MODE === 'mock';
const MOCK_USER: AuthUser = { email: 'demo@example.com', displayName: 'Demo' };
let mockSignedIn = true; // mock 모드는 로그인된 상태로 시작한다 (화면만 고칠 때 바로 보이게)

const USER_POOL_ID = import.meta.env.USER_POOL_ID;
const CLIENT_ID = import.meta.env.COGNITO_CLIENT_ID;

export function configureAuth() {
    if (MOCK || !USER_POOL_ID || !CLIENT_ID) return;
    Amplify.configure({
        Auth: {
            Cognito: {
                userPoolId: USER_POOL_ID,
                userPoolClientId: CLIENT_ID,
                loginWith: { email: true },
                signUpVerificationMethod: 'code',
            },
        },
    });
}

function requireConfig() {
    if (!MOCK && (!USER_POOL_ID || !CLIENT_ID)) {
        throw new Error(
            'Cognito 설정(USER_POOL_ID, COGNITO_CLIENT_ID)이 없습니다. deploy.sh가 만든 frontend/.env.local이 있는지 확인하세요.',
        );
    }
}

// Amplify(Cognito) 오류를 화면에 보여 줄 한국어 문장으로 바꾼다. 모르는 오류는 원문을 그대로 보여 준다
export function authErrorText(error: unknown): string {
    const name = (error as { name?: string })?.name ?? '';
    const messages: Record<string, string> = {
        NotAuthorizedException: '이메일 또는 비밀번호가 올바르지 않습니다.',
        UserNotFoundException: '이메일 또는 비밀번호가 올바르지 않습니다.',
        UsernameExistsException: '이미 가입된 이메일입니다. 로그인해 주세요.',
        CodeMismatchException: '인증 코드가 올바르지 않습니다.',
        ExpiredCodeException: '인증 코드가 만료되었습니다. 코드를 다시 받아 주세요.',
        InvalidPasswordException:
            '비밀번호는 8자 이상이고 대문자·소문자·숫자·특수 문자를 모두 포함해야 합니다.',
        LimitExceededException: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.',
        TooManyRequestsException: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
        InvalidParameterException: '입력 값을 확인해 주세요.',
        NetworkError: '서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.',
    };
    if (messages[name]) return messages[name];
    if (error instanceof Error && error.message) return error.message;
    return '요청 처리 중 문제가 발생했습니다.';
}

function toStep(signInStep: string): LoginStep {
    switch (signInStep) {
        case 'DONE':
            return 'done';
        case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
            return 'new-password';
        case 'CONFIRM_SIGN_UP':
            return 'confirm-sign-up';
        case 'RESET_PASSWORD':
            return 'reset-password';
        default:
            // MFA 등은 이 User Pool에서 켜지 않았다
            throw new Error(`지원하지 않는 로그인 단계입니다: ${signInStep}`);
    }
}

export async function currentUser(): Promise<AuthUser | null> {
    if (MOCK) return mockSignedIn ? MOCK_USER : null;
    if (!USER_POOL_ID || !CLIENT_ID) return null;
    try {
        await getCurrentUser();
        const attributes = await fetchUserAttributes();
        const email = attributes.email ?? '';
        return { email, displayName: attributes.name || email.split('@')[0] };
    } catch {
        return null; // 로그인하지 않았거나 세션이 만료됨
    }
}

// API 요청에 붙일 ID 토큰 (API Gateway의 Cognito Authorizer가 확인한다). 만료되면 Amplify가 갱신한다
export async function idToken(): Promise<string | null> {
    if (MOCK || !USER_POOL_ID || !CLIENT_ID) return null;
    try {
        const session = await fetchAuthSession();
        return session.tokens?.idToken?.toString() ?? null;
    } catch {
        return null;
    }
}

export async function login(email: string, password: string): Promise<LoginStep> {
    requireConfig();
    if (MOCK) {
        mockSignedIn = true;
        return 'done';
    }
    try {
        const { nextStep } = await signIn({ username: email, password });
        return toStep(nextStep.signInStep);
    } catch (error) {
        // 이전 세션이 남아 있으면(다른 탭에서 로그인 등) 로그인된 것으로 본다
        if ((error as { name?: string })?.name === 'UserAlreadyAuthenticatedException') return 'done';
        throw error;
    }
}

export async function completeNewPassword(newPassword: string): Promise<LoginStep> {
    if (MOCK) return 'done';
    const { nextStep } = await confirmSignIn({ challengeResponse: newPassword });
    return toStep(nextStep.signInStep);
}

// 가입. 이메일로 받은 인증 코드를 confirmRegistration으로 확인해야 로그인할 수 있다
export async function register(email: string, password: string, name: string): Promise<void> {
    requireConfig();
    if (MOCK) return;
    await signUp({
        username: email,
        password,
        options: { userAttributes: { email, ...(name ? { name } : {}) } },
    });
}

export async function confirmRegistration(email: string, code: string): Promise<void> {
    if (MOCK) return;
    await confirmSignUp({ username: email, confirmationCode: code });
}

export async function resendCode(email: string): Promise<void> {
    if (MOCK) return;
    await resendSignUpCode({ username: email });
}

export async function requestPasswordReset(email: string): Promise<void> {
    requireConfig();
    if (MOCK) return;
    await resetPassword({ username: email });
}

export async function completePasswordReset(email: string, code: string, newPassword: string) {
    if (MOCK) return;
    await confirmResetPassword({ username: email, confirmationCode: code, newPassword });
}

export async function logout(): Promise<void> {
    if (MOCK) {
        mockSignedIn = false;
        return;
    }
    await signOut();
}
