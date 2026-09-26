// 검색창 (Datadog의 검색 줄을 따랐다). 감사 로그와 사용자 관리가 같이 쓴다
//   🔍 요청자·도구·리소스 ID·질문 내용으로 찾기                                   [/]
// - 글자를 멈추고 잠깐(delayMs) 뒤에 알린다 (목록을 글자마다 다시 거르지 않게)
// - '/'를 누르면 검색창으로 간다 (다른 입력칸에 쓰는 중이 아닐 때). 검색창에서 Esc: 글자가 있으면 지우고, 없으면 빠져나간다
// - 바깥에서 검색어가 바뀌면(필터 초기화 등) 검색창 글자도 따라 바뀐다
import { useEffect, useRef, useState } from 'react';

const isTyping = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function SearchBox({
    value,
    onChange,
    placeholder,
    label,
    title,
    delayMs = 200,
}: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    label: string; // 화면 읽기 프로그램용 설명 (찾는 규칙까지)
    title?: string; // 마우스를 올리면 뜨는 찾는 규칙
    delayMs?: number;
}) {
    const [text, setText] = useState(value);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => setText(value), [value]);

    useEffect(() => {
        if (text === value) return;
        const timer = window.setTimeout(() => onChange(text), delayMs);
        return () => window.clearTimeout(timer);
    }, [text]); // 글자가 바뀔 때만 (value가 따라 바뀌어 다시 도는 것은 위 비교가 막는다)

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
            event.preventDefault();
            input.current?.focus();
            input.current?.select();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    return (
        <div className="search-box">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M20 20l-3.5-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
                ref={input}
                type="search"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key !== 'Escape') return;
                    event.preventDefault(); // 검색창 안의 Esc는 여기서 끝낸다 (다른 Esc 처리는 defaultPrevented를 보고 넘어간다)
                    if (text) {
                        setText('');
                        onChange('');
                    } else input.current?.blur();
                }}
                placeholder={placeholder}
                aria-label={label}
                title={title}
            />
            <kbd aria-hidden="true">/</kbd>
        </div>
    );
}
