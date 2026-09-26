// 홈: 흰 카드(AXPI 패널) 안에 FinGate-X 첫 화면의 구성을 넣었다.
//   큰 글씨 2줄(가는 글씨 · 굵은 파랑) → 작은 글씨 설명 → 큰 입력창
// 예시 질문은 입력칸을 누르면 입력칸 아래에 펼쳐진다 (Composer의 suggestions). 지난 대화는 대화 탭의 '대화 목록'에서 본다.
import { useNavigate } from 'react-router-dom';
import { ToastHost } from '@/components/Toast';
import { Composer } from '@/features/chat/Composer';
import { useChatStore } from '@/stores/chatStore';
import { EXAMPLE_QUESTIONS } from './examples';
import './home.css';

export function HomePage() {
    const navigate = useNavigate();

    // 새 대화로 질문을 보내고 대화 화면으로 간다. 답변은 대화 화면에서 이어서 보인다
    const ask = (question: string) => {
        const store = useChatStore.getState();
        if (!store.waitingForResponse) {
            store.newChat();
            store.sendMessage(question);
        }
        navigate('/chat');
    };

    return (
        <section className="plan-panel home-panel" aria-label="홈">
            {/* 알림 자리 (다른 탭과 같다, components/Toast) */}
            <ToastHost />
            <div className="home-hero">
                {/* 읽는 순서대로 한 줄씩 떠오른다. 지연 시간을 줄마다 적어 두어 순서가 마크업에 보이게 했다 (FinGate-X) */}
                <h1 className="home-headline">
                    <span className="reveal" style={{ animationDelay: '60ms' }}>
                        로그 찾고, 콘솔 열고, 비용 표 뒤지고?
                    </span>
                    <b className="reveal" style={{ animationDelay: '220ms' }}>
                        한 문장으로 물어보세요.
                    </b>
                </h1>
                <p className="home-standfirst reveal" style={{ animationDelay: '430ms' }}>
                    CloudWatch 로그·알람·대시보드와 비용, AWS 문서를 MCP 도구로 찾아 답합니다. 어떤 도구를
                    썼는지는 답마다 함께 보여 드립니다.
                </p>

                {/* 입력창은 떠오르지 않는다: 손이 기다려야 하는 컨트롤은 처음부터 그 자리에 있어야 한다 */}
                <Composer
                    variant="home"
                    placeholder={`편하게 물어보세요. 예: ${EXAMPLE_QUESTIONS[0].question}`}
                    onSend={ask}
                    suggestions={EXAMPLE_QUESTIONS}
                />
            </div>
        </section>
    );
}
