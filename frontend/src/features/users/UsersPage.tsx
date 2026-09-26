// 사용자 관리 화면 (관리자만): 권한(일반 사용자 · 결정자 · 관리자)을 정하고, 계정을 정지하거나 초대한다
// (services/llm/user_admin.py).
//   머리: 제목 · 새로 고침(아이콘)
//   도구 줄: 이메일 검색 · 초대(이메일 → 임시 비밀번호 메일, 일반 사용자로 시작)
//   목록: 이메일(나 · 이름 · 초대됨) · 권한 · 가입일 · 계정(정지/정지 해제). 정지된 계정은 흐리게
//
// - 관리자를 아래 권한으로 내리기와 정지는 한 번 더 눌러야 한다 (되돌릴 수 있지만 그 사람의 일이 바로 막힌다)
// - 자기 권한 바꾸기·자기 정지는 버튼을 끄고, 서버도 막는다. 마지막 관리자도 서버가 막는다
// - 바꾼 내용은 감사 로그의 '사용자 관리'에 남는다
// - 권한을 바꿔도 그 사람의 화면·권한은 다시 로그인하거나 토큰이 갱신된 뒤(최대 1시간) 바뀐다
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { inviteUser, listUsers, setEnabled, setRole, userErrorText } from '@/api/users';
import { ROLE_LABELS } from '@/auth/authClient';
import { LoadingCard, useMinimumVisible } from '@/components/LoadingCard';
import { RefreshButton } from '@/components/RefreshButton';
import type { ManagedUser, UserRole } from '@/types/users';
import { formatKoreanDateTime } from '@/utils/formatters';
import './users.css';

const ROLES: UserRole[] = ['member', 'decider', 'admin'];

// 한 번 더 눌러야 실행되는 버튼 (4초 안에). 되돌릴 수 있지만 그 사람의 일이 바로 막히는 동작에 쓴다
function ConfirmButton({
    label,
    confirmLabel,
    className,
    disabled,
    title,
    onConfirm,
}: {
    label: string;
    confirmLabel: string;
    className: string;
    disabled?: boolean;
    title?: string;
    onConfirm: () => void;
}) {
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        if (!armed) return;
        const timer = window.setTimeout(() => setArmed(false), 4000);
        return () => window.clearTimeout(timer);
    }, [armed]);
    return (
        <button
            type="button"
            className={`${className}${armed ? ' is-armed' : ''}`}
            disabled={disabled}
            title={title}
            onClick={() => {
                if (armed) {
                    setArmed(false);
                    onConfirm();
                } else setArmed(true);
            }}
        >
            {armed ? confirmLabel : label}
        </button>
    );
}

// 권한 고르기 (세 칸 중 하나). 관리자를 아래 권한으로 내리는 것은 한 번 더 누른다
function RoleSelect({ user, busy, onChange }: { user: ManagedUser; busy: boolean; onChange: (role: UserRole) => void }) {
    const [armed, setArmed] = useState<UserRole | null>(null);
    useEffect(() => {
        if (!armed) return;
        const timer = window.setTimeout(() => setArmed(null), 4000);
        return () => window.clearTimeout(timer);
    }, [armed]);
    return (
        <div className="users-roles" role="radiogroup" aria-label={`${user.email ?? user.username}의 권한`}>
            {ROLES.map((role) => {
                const selected = user.role === role;
                const demote = user.role === 'admin' && role !== 'admin';
                return (
                    <button
                        key={role}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`users-role${selected ? ' is-selected' : ''}${armed === role ? ' is-armed' : ''}`}
                        // 자기 권한은 바꿀 수 없다 (관리자를 내리면 스스로 잠긴다. 서버도 막는다)
                        disabled={busy || user.isSelf}
                        title={user.isSelf ? '자기 권한은 바꿀 수 없습니다' : undefined}
                        onClick={() => {
                            if (selected) return;
                            if (demote && armed !== role) {
                                setArmed(role);
                                return;
                            }
                            setArmed(null);
                            onChange(role);
                        }}
                    >
                        {armed === role ? '내리기 확인' : ROLE_LABELS[role]}
                    </button>
                );
            })}
        </div>
    );
}

export function UsersPage() {
    const [query, setQuery] = useState('');
    const [search, setSearch] = useState(''); // 입력을 멈춘 뒤의 검색어
    const [users, setUsers] = useState<ManagedUser[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState<'list' | 'more' | null>('list');
    const listLoading = useMinimumVisible(loading === 'list'); // 목록 자리의 기다림 카드 (최소 1초)
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null); // 바꾸는 중인 사용자
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviting, setInviting] = useState(false);
    const requestNo = useRef(0); // 마지막 조회의 응답만 쓴다

    const load = useCallback(
        async (next?: string | null) => {
            const no = ++requestNo.current;
            setLoading(next ? 'more' : 'list');
            setError(null);
            try {
                const page = await listUsers(search, next);
                if (no !== requestNo.current) return;
                setUsers((prev) => (next ? [...prev, ...page.users] : page.users));
                setCursor(page.cursor ?? null);
            } catch (err) {
                if (no !== requestNo.current) return;
                setError(userErrorText(err));
                if (!next) setUsers([]);
            } finally {
                if (no === requestNo.current) setLoading(null);
            }
        },
        [search],
    );

    useEffect(() => {
        load();
    }, [load]);

    // 입력을 0.3초 멈추면 검색한다
    useEffect(() => {
        const timer = window.setTimeout(() => setSearch(query.trim()), 300);
        return () => window.clearTimeout(timer);
    }, [query]);

    const change = async (user: ManagedUser, action: () => Promise<ManagedUser>, done: string) => {
        setBusy(user.username);
        setError(null);
        setNotice(null);
        try {
            const updated = await action();
            setUsers((prev) => prev.map((item) => (item.username === updated.username ? updated : item)));
            setNotice(`${updated.email ?? updated.username}: ${done}`);
        } catch (err) {
            setError(userErrorText(err));
        } finally {
            setBusy(null);
        }
    };

    const invite = async (event: FormEvent) => {
        event.preventDefault();
        const email = inviteEmail.trim();
        if (!email) return;
        setInviting(true);
        setError(null);
        setNotice(null);
        try {
            const created = await inviteUser(email);
            setUsers((prev) => [created, ...prev.filter((item) => item.username !== created.username)]);
            setInviteEmail('');
            setNotice(`${email}에 초대 메일을 보냈습니다 (임시 비밀번호, 7일 동안 유효)`);
        } catch (err) {
            setError(userErrorText(err));
        } finally {
            setInviting(false);
        }
    };

    return (
        <section className="plan-panel users-panel" aria-label="사용자 관리">
            <div className="plan-panel-header">
                <h1 className="plan-panel-eyebrow">사용자 관리</h1>
                <RefreshButton onClick={() => load()} loading={loading !== null || listLoading} />
            </div>

            <div className="users-toolbar">
                <label className="users-search">
                    <span className="audit-filter-label">검색</span>
                    <input
                        type="search"
                        className="users-input"
                        placeholder="이메일 앞부분"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        aria-label="이메일로 검색"
                    />
                </label>
                <form className="users-invite" onSubmit={invite}>
                    <input
                        type="email"
                        className="users-input"
                        placeholder="초대할 이메일"
                        value={inviteEmail}
                        onChange={(event) => setInviteEmail(event.target.value)}
                        aria-label="초대할 이메일"
                        required
                    />
                    <button type="submit" className="plan-create-button" disabled={inviting || !inviteEmail.trim()}>
                        {inviting ? '초대하는 중…' : '초대'}
                    </button>
                </form>
            </div>

            {error ? (
                <div className="plan-panel-error-inline" role="alert">
                    <p>{error}</p>
                </div>
            ) : null}
            {notice ? (
                <p className="users-notice" role="status">
                    {notice}
                </p>
            ) : null}

            <div className="plan-panel-body">
                <div className="plan-table users-table">
                    <div className="plan-table-header users-row-grid" aria-hidden="true">
                        <span>이메일</span>
                        <span>권한</span>
                        <span>가입일</span>
                        <span className="users-col-account">계정</span>
                    </div>

                    {/* 불러오는 동안 목록은 비워 두고, 카드는 흰 박스 전체의 가운데에 띄운다 (아래 plan-panel-loading) */}
                    {listLoading ? null : users.length === 0 ? (
                        error ? null : (
                            <div className="plan-panel-empty">
                                <p>{search ? '이 검색어로 시작하는 이메일이 없습니다.' : '사용자가 없습니다.'}</p>
                            </div>
                        )
                    ) : (
                        <ul className="plan-table-body users-table-body" aria-label="사용자 목록">
                            {users.map((user) => {
                                const rowBusy = busy === user.username;
                                return (
                                    <li
                                        key={user.username}
                                        className={`plan-table-row users-row${user.enabled ? '' : ' is-disabled'}`}
                                    >
                                        <div className="users-row-grid">
                                            <span className="users-col-email" title={user.username}>
                                                {user.email ?? user.username}
                                                {user.isSelf ? <span className="users-self">나</span> : null}
                                                {/* 초대만 되고 아직 첫 로그인(비밀번호 정하기) 전 */}
                                                {user.status === 'FORCE_CHANGE_PASSWORD' ? (
                                                    <span className="users-invited">초대됨</span>
                                                ) : null}
                                                {user.name ? <span className="users-name">{user.name}</span> : null}
                                            </span>
                                            <span>
                                                <RoleSelect
                                                    user={user}
                                                    busy={rowBusy}
                                                    onChange={(role) =>
                                                        change(
                                                            user,
                                                            () => setRole(user.username, role),
                                                            `권한을 ${ROLE_LABELS[role]}로 바꿨습니다`,
                                                        )
                                                    }
                                                />
                                            </span>
                                            <span className="users-col-date">
                                                {user.createdAt ? formatKoreanDateTime(user.createdAt) : '-'}
                                            </span>
                                            <span className="users-col-account">
                                                {user.enabled ? (
                                                    <ConfirmButton
                                                        label="정지"
                                                        confirmLabel="정지 확인"
                                                        className="users-account-button is-danger"
                                                        disabled={rowBusy || user.isSelf}
                                                        title={user.isSelf ? '자기 계정은 정지할 수 없습니다' : '로그인과 갱신을 막습니다'}
                                                        onConfirm={() =>
                                                            change(user, () => setEnabled(user.username, false), '정지했습니다')
                                                        }
                                                    />
                                                ) : (
                                                    <button
                                                        type="button"
                                                        className="users-account-button"
                                                        disabled={rowBusy}
                                                        onClick={() =>
                                                            change(user, () => setEnabled(user.username, true), '정지를 풀었습니다')
                                                        }
                                                    >
                                                        정지 해제
                                                    </button>
                                                )}
                                            </span>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
                {cursor && !listLoading ? (
                    <div className="audit-more">
                        <button
                            type="button"
                            className="plan-reload-button"
                            onClick={() => load(cursor)}
                            disabled={loading !== null}
                        >
                            {loading === 'more' ? '불러오는 중…' : '더 보기'}
                        </button>
                    </div>
                ) : null}
            </div>

            {listLoading ? (
                <div className="plan-panel-loading">
                    <LoadingCard text="사용자를 불러오는 중…" />
                </div>
            ) : null}
        </section>
    );
}
