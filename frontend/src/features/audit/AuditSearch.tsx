// 감사 로그 검색창 (Datadog의 검색 줄을 따랐다). 찾는 규칙은 auditModel.parseQuery·matchesQuery
//   🔍 요청자·도구·리소스 ID·질문 내용으로 찾기                                   [/]
// - 글자를 멈추고 0.2초 뒤에 거른다 (2,000건을 글자마다 다시 거르지 않게)
// - '/'를 누르면 검색창으로 간다 (다른 입력칸에 쓰는 중이 아닐 때). 검색창에서 Esc: 글자가 있으면 지우고, 없으면 빠져나간다
// - 옆 패널의 '같은 질문의 기록' 같은 버튼이 검색어를 바꾸면 검색창 글자도 따라 바뀐다
import { useEffect, useRef, useState } from 'react';

const DEBOUNCE_MS = 200;

const isTyping = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function AuditSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    const [text, setText] = useState(value);
    const input = useRef<HTMLInputElement>(null);

    // 바깥에서 검색어가 바뀌면(옆 패널 버튼, 조건 모두 지우기) 글자를 맞춘다
    useEffect(() => setText(value), [value]);

    useEffect(() => {
        if (text === value) return;
        const timer = window.setTimeout(() => onChange(text), DEBOUNCE_MS);
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
        <div className="audit-search">
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
                    event.preventDefault(); // 옆 패널이 함께 닫히지 않게 (패널은 defaultPrevented를 보고 넘어간다)
                    if (text) {
                        setText('');
                        onChange('');
                    } else input.current?.blur();
                }}
                placeholder="요청자·도구·리소스 ID·질문 내용으로 찾기"
                aria-label="감사 기록 검색. 띄어 쓰면 모두 들어 있는 기록, 따옴표는 한 덩어리, 앞에 -를 붙이면 그 낱말이 없는 기록"
                title={'띄어 쓰면 모두 들어 있는 기록만 · "따옴표"는 한 덩어리 · -낱말은 그 낱말이 없는 기록만'}
            />
            <kbd aria-hidden="true">/</kbd>
        </div>
    );
}
