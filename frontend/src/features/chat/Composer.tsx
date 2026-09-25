// 질문 입력칸 (홈과 대화 화면에서 함께 쓴다).
// Enter로 보내고 Shift+Enter로 줄을 바꾼다. 답변을 기다리는 중에는 보내기 버튼이 취소 버튼이 되고 Esc로도 취소한다.
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useModelsStore } from '@/stores/modelsStore';

const MAX_HEIGHT = 150; // 입력칸이 늘어나는 최대 높이

export function Composer({
    variant,
    placeholder,
    onSend,
}: {
    variant: 'home' | 'chat';
    placeholder: string;
    onSend: (text: string) => void;
}) {
    const [text, setText] = useState('');
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const waiting = useChatStore((s) => s.waitingForResponse);
    const models = useModelsStore((s) => s.models);
    const selectedModel = useModelsStore((s) => s.selectedModel);
    const selectModel = useModelsStore((s) => s.selectModel);
    const busy = variant === 'chat' && waiting;

    // 글이 늘어나면 입력칸도 함께 늘린다
    useEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, MAX_HEIGHT)}px`;
    }, [text]);

    const send = () => {
        if (!text.trim() || busy) return;
        onSend(text.trim());
        setText('');
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        // 한글을 조합하는 중의 Enter는 글자를 확정하는 Enter다. 이때 보내면 마지막 글자가 두 번 들어간다
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
        } else if (event.key === 'Escape' && busy) {
            useChatStore.getState().cancelRequest();
        }
    };

    return (
        <div className={`composer composer--${variant}`}>
            <textarea
                ref={inputRef}
                className="composer-input"
                rows={1}
                placeholder={placeholder}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={handleKeyDown}
                aria-label="질문"
            />
            <div className="composer-actions">
                {models.length > 0 ? (
                    <select
                        className="composer-model"
                        value={selectedModel.id}
                        disabled={busy}
                        onChange={(event) => selectModel(event.target.value)}
                        aria-label="모델"
                    >
                        {models.map((model) => (
                            <option key={model.id} value={model.id}>
                                {model.display_name}
                            </option>
                        ))}
                    </select>
                ) : null}
                {busy ? (
                    <button
                        className="plan-create-button composer-send is-cancel"
                        type="button"
                        onClick={() => useChatStore.getState().cancelRequest()}
                    >
                        <span className="plan-inline-spinner composer-spinner" aria-hidden="true" />
                        취소
                    </button>
                ) : (
                    <button
                        className="plan-create-button composer-send"
                        type="button"
                        disabled={!text.trim()}
                        onClick={send}
                    >
                        질문하기
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
                        </svg>
                    </button>
                )}
            </div>
        </div>
    );
}
