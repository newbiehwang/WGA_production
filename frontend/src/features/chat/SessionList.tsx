// 대화 목록 (예전 components/ChatHistory.vue). 대화 목록 팝업창(SessionListModal) 안에 들어간다.
// 행 모양과 ··· 메뉴는 AXPI의 추진 계획서 목록 행을 그대로 쓴다.
import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useChatStore } from '@/stores/chatStore';
import type { ChatSession } from '@/types/chat';
import { formatKoreanDateTime, getErrorText } from '@/utils/formatters';

type Dialog =
    | { kind: 'rename'; session: ChatSession }
    | { kind: 'delete'; session: ChatSession }
    | { kind: 'delete-all' }
    | null;

export function SessionList({
    onSelect,
    actions,
}: {
    onSelect: (sessionId: string) => void;
    actions?: ReactNode; // 아래 버튼 줄 오른쪽에 둘 버튼 (팝업의 '+ 새 대화')
}) {
    const sessions = useChatStore((s) => s.sessions);
    const currentId = useChatStore((s) => s.currentSession?.sessionId);
    const loaded = useChatStore((s) => s.loaded);
    const waiting = useChatStore((s) => s.waitingForResponse);

    // ··· 메뉴: 목록이 스크롤되는 상자 안에 있으므로 잘리지 않게 화면 기준 위치(fixed)로 띄운다 (AXPI와 같은 방식)
    const [menu, setMenu] = useState<{ session: ChatSession; top: number; right: number } | null>(null);
    const [dialog, setDialog] = useState<Dialog>(null);
    const [title, setTitle] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!menu) return;
        const close = () => setMenu(null);
        window.addEventListener('mousedown', close);
        window.addEventListener('resize', close);
        window.addEventListener('scroll', close, true);
        return () => {
            window.removeEventListener('mousedown', close);
            window.removeEventListener('resize', close);
            window.removeEventListener('scroll', close, true);
        };
    }, [menu]);

    const open = (next: Dialog) => {
        setMenu(null);
        setError('');
        setTitle(next?.kind === 'rename' ? next.session.title : '');
        setDialog(next);
    };

    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        setError('');
        try {
            await action();
            setDialog(null);
        } catch (e) {
            setError(getErrorText(e));
        } finally {
            setBusy(false);
        }
    };

    const store = useChatStore.getState;

    return (
        <>
            {!loaded ? (
                <div className="chat-sessions-empty">
                    <div className="plan-inline-spinner" />
                </div>
            ) : sessions.length === 0 ? (
                <div className="chat-sessions-empty">
                    <p>대화 내역이 없습니다.</p>
                </div>
            ) : (
                <ul className="plan-table-body chat-session-list">
                    {sessions.map((session) => (
                        <li
                            key={session.sessionId}
                            className={`plan-table-row is-clickable chat-session-row${
                                session.sessionId === currentId ? ' is-selected' : ''
                            }${menu?.session.sessionId === session.sessionId ? ' is-action-open' : ''}`}
                            role="button"
                            tabIndex={0}
                            aria-current={session.sessionId === currentId}
                            onClick={() => onSelect(session.sessionId)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    onSelect(session.sessionId);
                                }
                            }}
                        >
                            <div className="chat-session-meta">
                                <span className="plan-row-name">{session.title}</span>
                                <span className="chat-session-date">{formatKoreanDateTime(session.updatedAt)}</span>
                            </div>
                            <div className="plan-row-action">
                                <button
                                    className="plan-action-btn"
                                    type="button"
                                    aria-label={`${session.title} 메뉴`}
                                    aria-expanded={menu?.session.sessionId === session.sessionId}
                                    disabled={waiting}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        if (menu?.session.sessionId === session.sessionId) {
                                            setMenu(null);
                                            return;
                                        }
                                        const rect = event.currentTarget.getBoundingClientRect();
                                        setMenu({ session, top: rect.bottom + 8, right: window.innerWidth - rect.right });
                                    }}
                                >
                                    ···
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            <div className="create-plan-wizard-actions">
                {sessions.length > 0 ? (
                    <button
                        className="create-plan-wizard-button is-secondary session-delete-all"
                        type="button"
                        disabled={waiting}
                        onClick={() => open({ kind: 'delete-all' })}
                    >
                        대화 전체 삭제
                    </button>
                ) : null}
                {actions}
            </div>

            {menu
                ? createPortal(
                      <div
                          className="plan-row-action-menu"
                          // 팝업창(z-index 90) 위에 떠야 한다
                          style={{ position: 'fixed', top: menu.top, right: menu.right, zIndex: 120 }}
                          role="menu"
                          onMouseDown={(event) => event.stopPropagation()}
                      >
                          <button
                              className="plan-row-action-menu-item"
                              type="button"
                              role="menuitem"
                              onClick={() => open({ kind: 'rename', session: menu.session })}
                          >
                              이름 바꾸기
                          </button>
                          <button
                              className="plan-row-action-menu-item is-danger"
                              type="button"
                              role="menuitem"
                              onClick={() => open({ kind: 'delete', session: menu.session })}
                          >
                              삭제
                          </button>
                      </div>,
                      document.body,
                  )
                : null}

            {dialog?.kind === 'rename' ? (
                <ConfirmDialog
                    label="대화 이름 바꾸기"
                    message={
                        <>
                            <span className="dialog-label">대화 이름</span>
                            <input
                                className="login-input"
                                autoFocus
                                value={title}
                                onChange={(event) => setTitle(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !event.nativeEvent.isComposing && title.trim())
                                        run(() => store().renameSession(dialog.session.sessionId, title.trim()));
                                }}
                            />
                        </>
                    }
                    confirmText="바꾸기"
                    tone="primary"
                    busy={busy}
                    error={error}
                    onConfirm={() => title.trim() && run(() => store().renameSession(dialog.session.sessionId, title.trim()))}
                    onCancel={() => setDialog(null)}
                />
            ) : null}

            {dialog?.kind === 'delete' ? (
                <ConfirmDialog
                    label="대화 삭제 확인"
                    message={
                        <>
                            <strong>{dialog.session.title}</strong> 대화를 삭제하시겠습니까? 되돌릴 수 없습니다.
                        </>
                    }
                    confirmText="삭제"
                    busy={busy}
                    error={error}
                    onConfirm={() => run(() => store().deleteSession(dialog.session.sessionId))}
                    onCancel={() => setDialog(null)}
                />
            ) : null}

            {dialog?.kind === 'delete-all' ? (
                <ConfirmDialog
                    label="전체 대화 삭제 확인"
                    message={
                        <>
                            <strong>대화 {sessions.length}개</strong>를 모두 삭제하시겠습니까? 되돌릴 수 없습니다.
                        </>
                    }
                    confirmText="전체 삭제"
                    busy={busy}
                    error={error}
                    onConfirm={() => run(() => store().deleteAllSessions())}
                    onCancel={() => setDialog(null)}
                />
            ) : null}
        </>
    );
}
