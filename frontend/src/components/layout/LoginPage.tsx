// 로그인 화면 (AXPI LoginPage.tsx의 모양 그대로, 로그인은 Cognito로 한다).
//
// Cognito Hosted UI가 해 주던 일도 이 화면이 한다. 화면(mode)은 다음처럼 바뀐다.
//   login ──(가입)──────────▶ sign-up ──▶ confirm(이메일 인증 코드) ──▶ 로그인
//         ──(비밀번호 찾기)──▶ forgot  ──▶ reset(코드 + 새 비밀번호)  ──▶ login
//         ──(관리자가 만든 계정의 첫 로그인)──▶ new-password ──▶ 로그인
//         ──(인증하지 않은 계정)──▶ confirm
import { type FormEvent, useState } from 'react';
import {
    authErrorText,
    completeNewPassword,
    completePasswordReset,
    confirmRegistration,
    login,
    register,
    requestPasswordReset,
    resendCode,
    type LoginStep,
} from '@/auth/authClient';
import { LogoMark } from './LogoMark';

type Mode = 'login' | 'sign-up' | 'confirm' | 'forgot' | 'reset' | 'new-password';

const HEADINGS: Record<Mode, { title: string; description: string; submit: string; busy: string }> = {
    login: { title: '로그인', description: 'WGA 계정으로 로그인 해주세요.', submit: '로그인', busy: '로그인 중...' },
    'sign-up': { title: '회원가입', description: '이메일로 가입합니다. 인증 코드를 보내 드립니다.', submit: '가입하기', busy: '가입 중...' },
    confirm: { title: '이메일 인증', description: '이메일로 받은 인증 코드를 입력해 주세요.', submit: '인증하기', busy: '확인 중...' },
    forgot: { title: '비밀번호 찾기', description: '가입한 이메일로 재설정 코드를 보내 드립니다.', submit: '코드 받기', busy: '보내는 중...' },
    reset: { title: '비밀번호 재설정', description: '이메일로 받은 코드와 새 비밀번호를 입력해 주세요.', submit: '비밀번호 바꾸기', busy: '바꾸는 중...' },
    'new-password': { title: '새 비밀번호', description: '처음 로그인했습니다. 앞으로 쓸 비밀번호를 정해 주세요.', submit: '비밀번호 정하기', busy: '저장 중...' },
};

const PASSWORD_RULE = '8자 이상, 대문자·소문자·숫자·특수 문자를 모두 포함';

export function LoginPage({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
    const [mode, setMode] = useState<Mode>('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [code, setCode] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [isValidationError, setIsValidationError] = useState(false);
    const [notice, setNotice] = useState('');
    const heading = HEADINGS[mode];

    const go = (next: Mode, message = '') => {
        setMode(next);
        setErrorMessage('');
        setNotice(message);
        setCode('');
        setNewPassword('');
    };

    const fail = (message: string, validation = false) => {
        setErrorMessage(message);
        setIsValidationError(validation);
    };

    // 로그인 결과에 따라 다음 화면으로
    const follow = async (step: LoginStep) => {
        if (step === 'done') await onSignedIn();
        else if (step === 'new-password') go('new-password');
        else if (step === 'confirm-sign-up') {
            await resendCode(email.trim());
            go('confirm', '이메일 인증이 아직 끝나지 않았습니다. 인증 코드를 다시 보냈습니다.');
        } else if (step === 'reset-password') {
            await requestPasswordReset(email.trim());
            go('reset', '비밀번호를 다시 정해야 합니다. 재설정 코드를 이메일로 보냈습니다.');
        }
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const id = email.trim();
        const needs: Record<Mode, boolean> = {
            login: !!id && !!password,
            'sign-up': !!id && !!password,
            confirm: !!id && !!code.trim(),
            forgot: !!id,
            reset: !!id && !!code.trim() && !!newPassword,
            'new-password': !!newPassword,
        };
        if (!needs[mode]) {
            fail('필요한 값을 모두 입력해 주세요.', true);
            return;
        }

        setErrorMessage('');
        setIsSubmitting(true);
        try {
            if (mode === 'login') await follow(await login(id, password));
            else if (mode === 'new-password') await follow(await completeNewPassword(newPassword));
            else if (mode === 'sign-up') {
                await register(id, password, name.trim());
                go('confirm', `${id}로 인증 코드를 보냈습니다.`);
            } else if (mode === 'confirm') {
                await confirmRegistration(id, code.trim());
                // 가입할 때 입력한 비밀번호가 있으면 바로 로그인한다
                if (password) await follow(await login(id, password));
                else go('login', '인증이 끝났습니다. 로그인해 주세요.');
            } else if (mode === 'forgot') {
                await requestPasswordReset(id);
                go('reset', `${id}로 재설정 코드를 보냈습니다.`);
            } else if (mode === 'reset') {
                await completePasswordReset(id, code.trim(), newPassword);
                setPassword('');
                go('login', '비밀번호를 바꿨습니다. 새 비밀번호로 로그인해 주세요.');
            }
        } catch (error) {
            fail(authErrorText(error));
        } finally {
            setIsSubmitting(false);
        }
    };

    const showEmail = mode !== 'new-password';
    const showPassword = mode === 'login' || mode === 'sign-up';
    const showCode = mode === 'confirm' || mode === 'reset';
    const showNewPassword = mode === 'reset' || mode === 'new-password';

    return (
        <main className="login-shell">
            <section className="login-card" aria-label={heading.title}>
                <div className="login-brand">
                    <LogoMark showName={false} />
                    <div className="login-brand-text">
                        <h1 className="login-title">{heading.title}</h1>
                        <p className="login-description">{heading.description}</p>
                    </div>
                </div>

                <form className="login-form" onSubmit={handleSubmit} noValidate>
                    {showEmail ? (
                        <div className="login-field">
                            <label htmlFor="login-email">이메일</label>
                            <input
                                id="login-email"
                                className="login-input"
                                type="email"
                                autoComplete="username"
                                placeholder="이메일을 입력하세요"
                                value={email}
                                readOnly={mode === 'confirm' || mode === 'reset'}
                                onChange={(event) => setEmail(event.target.value)}
                            />
                        </div>
                    ) : null}

                    {mode === 'sign-up' ? (
                        <div className="login-field">
                            <label htmlFor="login-name">이름 (선택)</label>
                            <input
                                id="login-name"
                                className="login-input"
                                type="text"
                                autoComplete="name"
                                placeholder="화면에 보일 이름"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </div>
                    ) : null}

                    {showPassword ? (
                        <div className="login-field">
                            <label htmlFor="login-password">비밀번호</label>
                            <input
                                id="login-password"
                                className="login-input"
                                type="password"
                                autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
                                placeholder="비밀번호를 입력하세요"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                            />
                            {mode === 'sign-up' ? <p className="login-hint">{PASSWORD_RULE}</p> : null}
                        </div>
                    ) : null}

                    {showCode ? (
                        <div className="login-field">
                            <label htmlFor="login-code">인증 코드</label>
                            <input
                                id="login-code"
                                className="login-input"
                                type="text"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                placeholder="6자리 코드"
                                value={code}
                                onChange={(event) => setCode(event.target.value)}
                            />
                        </div>
                    ) : null}

                    {showNewPassword ? (
                        <div className="login-field">
                            <label htmlFor="login-new-password">새 비밀번호</label>
                            <input
                                id="login-new-password"
                                className="login-input"
                                type="password"
                                autoComplete="new-password"
                                placeholder="새 비밀번호를 입력하세요"
                                value={newPassword}
                                onChange={(event) => setNewPassword(event.target.value)}
                            />
                            <p className="login-hint">{PASSWORD_RULE}</p>
                        </div>
                    ) : null}

                    {notice && !errorMessage ? (
                        <div className="login-notice" role="status" aria-live="polite">
                            {notice}
                        </div>
                    ) : null}

                    {errorMessage ? (
                        <div className="login-error-alert" role="alert" aria-live="polite">
                            <div className="login-error-icon" aria-hidden="true">
                                !
                            </div>
                            <div className="login-error-content">
                                <p className="login-error-title">
                                    {isValidationError ? '입력 값을 확인해 주세요.' : `${heading.title}에 실패했습니다.`}
                                </p>
                                <p className="login-error-text">{errorMessage}</p>
                            </div>
                        </div>
                    ) : null}

                    <button className="login-submit" type="submit" disabled={isSubmitting}>
                        {isSubmitting ? heading.busy : heading.submit}
                    </button>
                </form>

                <div className="login-links">
                    {mode === 'login' ? (
                        <>
                            <button type="button" onClick={() => go('sign-up')}>
                                회원가입
                            </button>
                            <button type="button" onClick={() => go('forgot')}>
                                비밀번호 찾기
                            </button>
                        </>
                    ) : (
                        <button type="button" onClick={() => go('login')}>
                            로그인으로 돌아가기
                        </button>
                    )}
                    {mode === 'confirm' ? (
                        <button
                            type="button"
                            onClick={async () => {
                                try {
                                    await resendCode(email.trim());
                                    setErrorMessage('');
                                    setNotice('인증 코드를 다시 보냈습니다.');
                                } catch (error) {
                                    fail(authErrorText(error));
                                }
                            }}
                        >
                            코드 다시 받기
                        </button>
                    ) : null}
                </div>
            </section>
        </main>
    );
}
