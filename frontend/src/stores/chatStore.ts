// 대화 목록과 지금 대화 (예전 stores/chatHistoryStore.ts를 옮겼다).
//
// API (services/chat-history, services/llm)
//   GET/POST/DELETE /sessions                  대화 목록 / 새 대화 / 전체 삭제
//   GET/PUT/DELETE  /sessions/{id}             대화 하나 / 제목 변경 / 삭제
//   GET/POST        /sessions/{id}/messages    메시지 목록 / 메시지 저장
//   POST            /llm1                      답변 만들기 (MCP 도구 호출 포함, 수십 초 걸릴 수 있다)
// 사용자는 백엔드가 ID 토큰의 sub로 구분한다 (예전처럼 userId를 보내지 않는다).
//
// 질문 하나를 보내는 순서: 내 메시지 저장 → 화면에 "..." → /llm1 → 답변 저장 → 타이핑하듯 보여 주기
import axios, { type CancelTokenSource } from 'axios';
import { create } from 'zustand';
import type { BotResponse, ChatMessageType, ChatSession } from '@/types/chat';
import { useModelsStore } from './modelsStore';

const newId = () => Date.now().toString(36) + Math.random().toString(36).substring(2);
const shortTitle = (text: string) => (text.length > 30 ? `${text.substring(0, 30)}...` : text);
const byUpdatedAt = (a: ChatSession, b: ChatSession) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();

const ERROR_ANSWER = '죄송합니다. 응답을 처리하는 중에 오류가 발생했습니다. 다시 시도해 주세요.';
const CANCEL_ANSWER = '요청이 취소되었습니다.';
const TYPING_MS_PER_CHAR = 10; // 답변을 타이핑하듯 보여 주는 속도
const TYPING_MAX_MS = 2000; // 긴 답변도 이 시간 안에 다 보여 준다

interface ChatState {
    sessions: ChatSession[]; // 목록에는 메시지 없이 요약만 둔다
    currentSession: ChatSession | null; // null이면 새 대화 (첫 질문을 보낼 때 만든다)
    loaded: boolean; // 목록을 한 번이라도 받았는지
    loading: boolean;
    error: string | null;
    waitingForResponse: boolean;
    cancelSource: CancelTokenSource | null;

    fetchSessions: () => Promise<void>;
    selectSession: (sessionId: string) => Promise<void>;
    newChat: () => void;
    sendMessage: (text: string) => Promise<void>;
    cancelRequest: () => void;
    renameSession: (sessionId: string, title: string) => Promise<void>;
    deleteSession: (sessionId: string) => Promise<void>;
    deleteAllSessions: () => Promise<void>;
    setError: (message: string | null) => void;
}

// /llm1 응답을 화면에 보여 줄 답변으로 바꾼다 (응답 모양이 여러 가지인 예전 백엔드도 받아 준다)
function toBotResponse(data: any): BotResponse {
    if (!data) return { text: '죄송합니다. 유효한 응답 데이터를 받지 못했습니다.' };
    if (data.inference || data.query_string) {
        return {
            text: data.answer || '쿼리 결과 없음',
            query_string: data.query_string,
            query_result: data.query_result || [],
            elapsed_time: data.elapsed_time,
            inference: data.inference,
        };
    }
    if (Array.isArray(data.answer)) {
        const items = [...data.answer].sort((a, b) => a.rank_order - b.rank_order);
        return {
            text: items.map((item) => `${item.context}\n${item.title}\n${item.url}`).join('\n\n'),
            elapsed_time: data.elapsed_time,
        };
    }
    return {
        text: typeof data.answer === 'string' ? data.answer : JSON.stringify(data.answer),
        elapsed_time: data.elapsed_time,
    };
}

export const useChatStore = create<ChatState>((set, get) => {
    let inflight: Promise<void> | null = null; // 받고 있는 대화 목록 요청

    // 지금 보고 있는 대화가 sessionId일 때만 메시지를 바꾼다.
    // 답변을 기다리는 중에 다른 대화로 옮겨 가면, 늦게 온 답변이 엉뚱한 대화에 붙지 않게 한다
    const updateMessages = (sessionId: string, fn: (messages: ChatMessageType[]) => ChatMessageType[]) =>
        set((state) =>
            state.currentSession?.sessionId === sessionId
                ? { currentSession: { ...state.currentSession, messages: fn(state.currentSession.messages) } }
                : {},
        );

    const touchSession = (sessionId: string, patch: Partial<ChatSession>) =>
        set((state) => ({
            sessions: state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, ...patch } : s)).sort(byUpdatedAt),
            currentSession:
                state.currentSession?.sessionId === sessionId ? { ...state.currentSession, ...patch } : state.currentSession,
        }));

    const saveMessage = async (sessionId: string, message: Record<string, unknown>, cancel?: CancelTokenSource) =>
        (await axios.post(`/sessions/${sessionId}/messages`, message, { cancelToken: cancel?.token }))
            .data as ChatMessageType;

    // 답변을 한 글자씩 늘려 가며 보여 준다. 글자마다 그리지 않고 시간에 맞춰 여러 글자씩 늘린다
    const typeOut = (sessionId: string, messageId: string, fullText: string) => {
        const total = Math.min(fullText.length * TYPING_MS_PER_CHAR, TYPING_MAX_MS);
        const started = performance.now();
        const setMessage = (patch: Partial<ChatMessageType>) =>
            updateMessages(sessionId, (messages) => messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)));

        const tick = () => {
            const shown = total ? Math.ceil((fullText.length * (performance.now() - started)) / total) : fullText.length;
            if (shown >= fullText.length) {
                setMessage({ displayText: fullText, animationState: 'complete' });
                return;
            }
            setMessage({ displayText: fullText.slice(0, shown) });
            setTimeout(tick, 30);
        };
        tick();
    };

    return {
        sessions: [],
        currentSession: null,
        loaded: false,
        loading: false,
        error: null,
        waitingForResponse: false,
        cancelSource: null,

        fetchSessions: () => {
            // 홈과 대화 화면이 거의 동시에 부를 수 있다. 받는 중이면 같은 요청을 기다린다
            if (inflight) return inflight;
            inflight = (async () => {
                set({ loading: true, error: null });
                try {
                    const response = await axios.get('/sessions');
                    const fetched: ChatSession[] = response.data.sessions || [];
                    // 목록을 받는 사이에 홈에서 보낸 질문으로 새 대화가 생겼을 수 있다. 그 대화도 목록에 남긴다
                    set((state) => {
                        const ids = new Set(fetched.map((session) => session.sessionId));
                        const created = state.sessions.filter((session) => !ids.has(session.sessionId));
                        return { sessions: [...created, ...fetched].sort(byUpdatedAt), loaded: true };
                    });
                    // 처음 열었을 때는 가장 최근 대화를 연다. 새 대화에 질문하는 중이면 그대로 둔다
                    const { currentSession, waitingForResponse, sessions } = get();
                    if (!currentSession && !waitingForResponse && sessions.length > 0)
                        await get().selectSession(sessions[0].sessionId);
                } catch (error) {
                    set({ error: '대화 목록을 불러오지 못했습니다.' });
                    throw error;
                } finally {
                    set({ loading: false });
                    inflight = null;
                }
            })();
            return inflight;
        },

        selectSession: async (sessionId) => {
            set({ loading: true, error: null });
            try {
                const [session, messages] = await Promise.all([
                    axios.get(`/sessions/${sessionId}`),
                    axios.get(`/sessions/${sessionId}/messages`),
                ]);
                set({ currentSession: { ...session.data, messages: messages.data.messages || [] } });
            } catch (error) {
                set({ error: '대화를 불러오지 못했습니다.' });
                throw error;
            } finally {
                set({ loading: false });
            }
        },

        newChat: () => set({ currentSession: null, error: null }),

        sendMessage: async (text) => {
            const question = text.trim();
            if (!question || get().waitingForResponse) return;
            // 취소 버튼은 보내자마자 보이므로, 취소 신호도 처음부터 만들어 모든 요청에 건다
            const cancelSource = axios.CancelToken.source();
            set({ waitingForResponse: true, error: null, cancelSource });

            let sessionId = '';
            const loadingId = newId();
            try {
                // 새 대화면 첫 질문을 제목으로 만든다
                let session = get().currentSession;
                if (!session) {
                    const created = (
                        await axios.post('/sessions', { title: shortTitle(question) }, { cancelToken: cancelSource.token })
                    ).data;
                    session = { ...created, messages: [] } as ChatSession;
                    set((state) => ({ currentSession: session, sessions: [session!, ...state.sessions] }));
                }
                sessionId = session.sessionId;
                const isFirstMessage = session.messages.length === 0;

                const userMessage = await saveMessage(sessionId, { sender: 'user', text: question }, cancelSource);
                updateMessages(sessionId, (messages) => [
                    ...messages,
                    { ...userMessage, animationState: 'appear' },
                    { id: loadingId, sender: 'assistant', text: '...', timestamp: new Date().toISOString(), isTyping: true },
                ]);
                // 예전에 만든 빈 대화('새 대화')에 처음 질문하면 제목을 질문으로 바꾼다
                if (isFirstMessage && session.title !== shortTitle(question)) {
                    await axios.put(`/sessions/${sessionId}`, { title: shortTitle(question) });
                    touchSession(sessionId, { title: shortTitle(question) });
                }

                const response = await axios.post(
                    '/llm1',
                    {
                        text: question,
                        sessionId,
                        modelId: useModelsStore.getState().selectedModel.id,
                        // 대화 컨텍스트는 항상 기억한다: 백엔드가 이 세션의 이전 대화를 함께 모델에 보낸다.
                        // 백엔드는 값이 없으면 false로 보므로 반드시 true를 보낸다
                        isCached: true,
                    },
                    { cancelToken: cancelSource.token },
                );
                const answer = toBotResponse(response.data);

                const saved = await saveMessage(sessionId, {
                    sender: 'assistant',
                    text: answer.text,
                    ...(answer.query_string && { query_string: answer.query_string }),
                    ...(answer.query_result?.length && { query_result: JSON.stringify(answer.query_result) }),
                    ...(answer.elapsed_time && { elapsed_time: answer.elapsed_time }),
                    ...(answer.inference && { inference: JSON.stringify(answer.inference) }),
                });
                // 저장한 메시지에는 JSON 문자열로 들어가므로, 화면에는 받은 그대로의 값을 쓴다
                const botMessage: ChatMessageType = {
                    ...saved,
                    ...answer,
                    displayText: '',
                    animationState: 'typing',
                };
                updateMessages(sessionId, (messages) => [...messages.filter((m) => m.id !== loadingId), botMessage]);
                touchSession(sessionId, { updatedAt: new Date().toISOString() });
                typeOut(sessionId, botMessage.id, answer.text);
            } catch (error) {
                const cancelled = axios.isCancel(error);
                const notice: ChatMessageType = {
                    id: newId(),
                    sender: 'assistant',
                    text: cancelled ? CANCEL_ANSWER : ERROR_ANSWER,
                    timestamp: new Date().toISOString(),
                    animationState: 'appear',
                };
                if (sessionId) {
                    updateMessages(sessionId, (messages) => [...messages.filter((m) => m.id !== loadingId), notice]);
                    // 다시 열었을 때도 무슨 일이 있었는지 보이도록 안내 문구도 저장한다
                    saveMessage(sessionId, { sender: 'assistant', text: notice.text }).catch(() => {});
                }
                if (!cancelled) set({ error: '메시지를 전송하는 중 오류가 발생했습니다.' });
            } finally {
                set({ waitingForResponse: false, cancelSource: null });
            }
        },

        cancelRequest: () => {
            get().cancelSource?.cancel('사용자가 요청을 취소했습니다.');
        },

        renameSession: async (sessionId, title) => {
            await axios.put(`/sessions/${sessionId}`, { title });
            set((state) => ({
                sessions: state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, title } : s)),
                currentSession:
                    state.currentSession?.sessionId === sessionId ? { ...state.currentSession, title } : state.currentSession,
            }));
        },

        deleteSession: async (sessionId) => {
            await axios.delete(`/sessions/${sessionId}`);
            const sessions = get().sessions.filter((s) => s.sessionId !== sessionId);
            set({ sessions });
            if (get().currentSession?.sessionId === sessionId) {
                set({ currentSession: null });
                if (sessions.length > 0) await get().selectSession(sessions[0].sessionId);
            }
        },

        deleteAllSessions: async () => {
            await axios.delete('/sessions');
            set({ sessions: [], currentSession: null });
        },

        setError: (message) => set({ error: message }),
    };
});
