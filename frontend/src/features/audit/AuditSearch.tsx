// 감사 로그 검색창 (components/SearchBox). 찾는 규칙은 auditModel.parseQuery·matchesQuery
import { SearchBox } from '@/components/SearchBox';

export function AuditSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    return (
        <SearchBox
            value={value}
            onChange={onChange}
            placeholder="요청자·도구·리소스 ID·질문 내용으로 찾기"
            label="감사 기록 검색. 띄어 쓰면 모두 들어 있는 기록, 따옴표는 한 덩어리, 앞에 -를 붙이면 그 낱말이 없는 기록"
            title={'띄어 쓰면 모두 들어 있는 기록만 · "따옴표"는 한 덩어리 · -낱말은 그 낱말이 없는 기록만'}
        />
    );
}
