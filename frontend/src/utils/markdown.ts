// src/utils/markdown.ts

// ---------------------------------------------------------------- 표 (GFM 형식)
//   | 사용자 | 요청 수 |
//   |---|--:|          ← 구분 줄. 콜론으로 정렬 (:-- 왼쪽, :-: 가운데, --: 오른쪽)
//   | alice | 42 |
// 입력은 호출하는 쪽에서 HTML 특수 문자를 이미 escape한 글이다 (ChatMessage.formatMessageContent).

type Align = '' | 'left' | 'center' | 'right';

const TABLE_ROW = /^\s*\|.*\|\s*$/;
// 구분 줄의 칸은 대시 1개 이상이면 된다 (GFM 규칙). 모델이 |:--|--:| 처럼 짧게 쓰는 경우가 많다.
// 파이프(|)가 있어야 구분 줄로 본다: 파이프 없는 --- 는 구분선(가로줄)이다
const TABLE_SEPARATOR = /^(?=.*\|)\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const PIPE = '\u0000'; // 셀 안의 \| (글자로서의 |)를 잠시 바꿔 둘 문자

const splitRow = (line: string): string[] => {
    const body = line.trim().replace(/\\\|/g, PIPE).replace(/^\|/, '').replace(/\|$/, '');
    return body.split('|').map((cell) => cell.trim().split(PIPE).join('|'));
};

const alignOf = (cell: string): Align => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
};

// 셀 안의 굵게·기울임·링크. 표 밖의 글에 쓰는 규칙과 같다
const inline = (text: string): string =>
    text
        .replace(/&lt;br\s*\/?&gt;/gi, '<br>') // 표 칸 안의 줄바꿈은 <br>로 쓰는 경우가 많다
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

const cellHtml = (tag: 'th' | 'td', text: string, align: Align): string =>
    `<${tag}${align ? ` style="text-align:${align}"` : ''}>${inline(text)}</${tag}>`;

// 표를 찾아 HTML로 바꾸고 자리표시자(__TABLE_n__)를 남긴다. 줄바꿈이 없는 한 줄 HTML이라
// 뒤의 문단 나누기(\n\n → </p><p>)에 걸리지 않는다
function extractTables(text: string, tables: string[]): string {
    const lines = text.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!(TABLE_ROW.test(lines[i]) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]))) {
            out.push(lines[i]);
            continue;
        }
        const header = splitRow(lines[i]);
        const aligns = splitRow(lines[i + 1]).map(alignOf);
        const rows: string[][] = [];
        let j = i + 2;
        for (; j < lines.length && TABLE_ROW.test(lines[j]); j++) {
            rows.push(splitRow(lines[j]));
        }
        // 칸 수는 머리글에 맞춘다 (모자라면 빈 칸, 넘치면 버림)
        const width = header.length;
        const fit = (row: string[]) => Array.from({ length: width }, (_, k) => row[k] ?? '');
        const thead = `<thead><tr>${header.map((c, k) => cellHtml('th', c, aligns[k] ?? '')).join('')}</tr></thead>`;
        const tbody = rows.length
            ? `<tbody>${rows.map((r) => `<tr>${fit(r).map((c, k) => cellHtml('td', c, aligns[k] ?? '')).join('')}</tr>`).join('')}</tbody>`
            : '';
        tables.push(`<div class="markdown-table-container"><table class="markdown-table">${thead}${tbody}</table></div>`);
        // 앞뒤를 빈 줄로 띄워 표가 문단(<p>) 안에 들어가지 않게 한다
        out.push('', `__TABLE_${tables.length - 1}__`, '');
        i = j - 1;
    }
    return out.join('\n');
}

// ``` 사이의 글을 코드 블록 HTML로 바꾼다.
// 여는 ``` 바로 뒤의 언어 이름(```bash)은 코드가 아니므로 본문에서 뺀다. 예전에는 코드 첫 줄처럼 찍혔다.
// 언어 이름은 class="language-bash"로 남겨 둔다 (나중에 문법 강조를 붙일 때 쓸 수 있게).
// 언어 이름은 여는 ``` 와 같은 줄에 있고 공백 없는 한 단어일 때만 인정한다: ```ls -la``` 같은 한 줄 코드는 그대로 둔다.
const CODE_LANGUAGE = /^([\w+#.-]+)[ \t]*\n/;

function codeBlock(body: string): string {
    const language = body.match(CODE_LANGUAGE);
    let code = language ? body.slice(language[0].length) : body.replace(/^[ \t]*\n/, '');
    code = code.replace(/\n[ \t]*$/, ''); // 닫는 ``` 앞의 줄바꿈 (빈 줄이 하나 더 생긴다)
    const attr = language ? ` class="language-${language[1]}"` : '';
    return `<pre><code${attr}>${code}</code></pre>`;
}

// 마크다운 파서(parseMarkdown)는 HTML 특수 문자를 이미 escape한 글을 받는다.
// 답변에 들어 있는 <script> 같은 글자가 HTML로 실행되지 않게 먼저 바꾼다 (대화창 ChatMessage, 감사 로그 AuditConversation)
export const escapeHtml = (text: string) =>
    text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

export function parseMarkdown(markdown: string): string {
    if (!markdown) return '';

    let html = markdown;

    const codeBlocks: string[] = [];
    html = html.replace(/```([^`]+)```/g, (_match, body: string) => {
        codeBlocks.push(codeBlock(body));
        return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    const inlineCodes: string[] = [];
    html = html.replace(/`([^`]+)`/g, (_match, code) => {
        inlineCodes.push(`<code>${code}</code>`);
        return `__INLINE_CODE_${inlineCodes.length - 1}__`;
    });

    const tables: string[] = [];
    html = extractTables(html, tables);

    // 답변 속 이미지 주소는 열지 않고 누를 수 있는 링크로만 보인다. 결과물(차트·다이어그램)은 artifact:// 참조로 오고
    // ChatMessage가 서버가 준 주소(inference.artifacts)로 따로 그린다.
    // 모델이 쓴 주소를 이미지로 열면, 주소에 데이터를 실어 밖으로 보내는 통로가 된다 (간접 프롬프트 인젝션 → 화면을
    // 여는 순간 브라우저가 요청). 버킷 이름 모양으로 허용하지도 않는다: S3 버킷 이름은 누구나 만들 수 있다
    html = html.replace(/!\[(.*?)\]\((.*?)\)/g, (match, altText, url) => {
        const cleanUrl = url.trim();
        try {
            const parsed = new URL(cleanUrl);
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
                return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer nofollow" class="markdown-image-link">[이미지] ${altText || parsed.hostname}</a>`;
            }
            return match;
        } catch (e) {
            return match;
        }
    });

    html = html.replace(/### (.*?)$/gm, '<h3>$1</h3>');
    html = html.replace(/## (.*?)$/gm, '<h2>$1</h2>');
    html = html.replace(/# (.*?)$/gm, '<h1>$1</h1>');

    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    html = html.replace(
        /\[(.*?)\]\((.*?)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );

    html = html.replace(/^\s*[\-\*]\s+(.*?)$/gm, '<li>$1</li>');
    // 이어진 항목을 목록 하나로 묶는다 (예전에는 항목마다 <ul>이 따로 생겨 사이가 벌어졌다)
    html = html.replace(
        /(?:^<li>.*<\/li>$(?:\n|$))+/gm,
        (block) => `<ul>${block.replace(/\n/g, '')}</ul>${block.endsWith('\n') ? '\n' : ''}`,
    );

    let listCounter = 0;
    let inOrderedList = false;

    html = html
        .split('\n')
        .map((line) => {
            const orderedListMatch = line.match(/^\s*(\d+)\.\s+(.*?)$/);

            if (orderedListMatch) {
                if (!inOrderedList) {
                    inOrderedList = true;
                    listCounter = parseInt(orderedListMatch[1]);
                    return `<ol start="${listCounter}"><li>${orderedListMatch[2]}</li>`;
                } else {
                    listCounter++;
                    return `<li>${orderedListMatch[2]}</li>`;
                }
            } else if (inOrderedList && line.trim() === '') {
                inOrderedList = false;
                // 목록을 끝낸 빈 줄은 문단 구분이기도 하다. 줄바꿈을 남겨 다음 글이 새 문단이 되게 한다
                return '</ol>\n';
            } else if (inOrderedList) {
                return line;
            } else {
                return line;
            }
        })
        .join('\n');

    if (inOrderedList) {
        html += '</ol>';
    }

    html = html.replace(/<\/ol>\s*<ol[^>]*>/g, '');
    // 목록 태그 사이의 줄바꿈을 지운다. 본문은 white-space: pre-wrap이라 태그 사이 줄바꿈이 빈 줄로 보인다
    html = html.replace(/(<\/li>|<ul>|<ol[^>]*>|<\/ul>)\n+(?=<li>|<\/ol>|<\/ul>|<ul>|<ol)/g, '$1');

    // 표는 문단 밖에 둔다 (<p> 안의 <table>은 올바른 HTML이 아니라 브라우저가 빈 문단을 더 만든다).
    // 코드 자리표시자보다 먼저 되돌려야 칸 안의 `코드`도 아래에서 함께 되돌아간다
    tables.forEach((table, index) => {
        const mark = `__TABLE_${index}__`;
        html = html.replace(new RegExp(`\\n*${mark}\\n*`), `</p>${table}<p>`);
    });

    codeBlocks.forEach((block, index) => {
        html = html.replace(`__CODE_BLOCK_${index}__`, block);
    });

    inlineCodes.forEach((code, index) => {
        html = html.replace(`__INLINE_CODE_${index}__`, code);
    });

    html = html.replace(/\n\s*\n/g, '</p><p>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<\/p><p><\/p><p>/g, '</p><p>');
    html = html.replace(/<p>\s*<\/p>/g, ''); // 표 앞뒤에 생긴 빈 문단

    return html;
}

export function renderMarkdown(el: HTMLElement, markdown: string): void {
    if (!markdown) {
        el.innerHTML = '';
        return;
    }

    const html = parseMarkdown(markdown);
    el.innerHTML = html;
}
