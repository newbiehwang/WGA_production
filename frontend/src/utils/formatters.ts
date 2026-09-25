// 화면에 보여 줄 글자 만들기 (AXPI utils/formatters.ts에서 가져왔다)

// 2026. 9. 25. 오후 3:12 (한국 시간)
export function formatKoreanDateTime(isoString: string): string {
    if (!isoString) return '-';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    const year = kst.getUTCFullYear();
    const month = kst.getUTCMonth() + 1;
    const day = kst.getUTCDate();
    const hours = kst.getUTCHours();
    const minutes = kst.getUTCMinutes();
    const ampm = hours < 12 ? '오전' : '오후';
    const hour12 = hours % 12 === 0 ? 12 : hours % 12;
    const mm = String(minutes).padStart(2, '0');
    return `${year}. ${month}. ${day}. ${ampm} ${hour12}:${mm}`;
}

// 프로필 동그라미에 넣을 두 글자 (이름이 없으면 ME)
export function makeAvatarLabel(displayName: string) {
    const compact = displayName.replace(/\s+/g, '');
    if (!compact) return 'ME';
    return compact.slice(0, 2).toUpperCase();
}

export function getErrorText(error: unknown) {
    if (error instanceof Error && error.message) return error.message;
    return '요청 처리 중 문제가 발생했습니다.';
}
