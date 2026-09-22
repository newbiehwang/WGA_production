import SwiftUI
import WGAInstallerKit

/// CLI의 질문(승인·입력·선택)을 보여 주고 답을 돌려준다.
/// 모든 변경 작업은 여기서 "실행할 명령"(비밀 값은 CLI가 이미 ***로 가림)을 보여 주고 승인받는다.
struct PromptSheet: View {
    @EnvironmentObject var model: WizardModel
    let context: PromptContext
    @State private var value = ""        // 입력 질문의 값. 보낸 뒤 바로 비운다
    @State private var choice = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch context.prompt {
            case let .confirm(_, command, reason):
                Text("변경 작업 승인").font(.title3).bold()
                Text(reason)
                ScrollView {
                    Text(command)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(minHeight: 60, maxHeight: 220)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                buttons(cancel: { answer(.confirm(id: context.prompt.id, approved: false)) },
                        confirm: ("실행", { answer(.confirm(id: context.prompt.id, approved: true)) }))

            case let .input(id, prompt, secret):
                Text(prompt).font(.title3).bold()
                if secret {
                    SecureField("값", text: $value)
                } else {
                    TextField("값", text: $value)
                }
                buttons(cancel: { send(id: id, secret: secret, value: "") },
                        confirm: ("확인", { send(id: id, secret: secret, value: value) }))

            case let .choice(id, prompt, options, defaultChoice):
                Text(prompt).font(.title3).bold()
                Picker("", selection: $choice) {
                    ForEach(options, id: \.id) { Text($0.label).tag($0.id) }
                }
                .pickerStyle(.radioGroup)
                .labelsHidden()
                .onAppear { choice = defaultChoice }
                buttons(cancel: { answer(.choice(id: id, choice: defaultChoice)) },
                        confirm: ("확인", { answer(.choice(id: id, choice: choice)) }))
            }
        }
        .padding(20)
        .frame(width: 560)
        // 시트 밖을 눌러 닫지 못하게 한다: CLI가 답을 기다리는 중이라 답 없이 닫히면 멈춘 것처럼 보인다
        .interactiveDismissDisabled()
    }

    private func buttons(cancel: @escaping () -> Void, confirm: (String, () -> Void)) -> some View {
        HStack {
            Spacer()
            Button("취소", role: .cancel, action: cancel).keyboardShortcut(.cancelAction)
            Button(confirm.0, action: confirm.1).keyboardShortcut(.defaultAction)
        }
    }

    private func send(id: String, secret: Bool, value: String) {
        answer(secret ? .secret(id: id, value: value) : .text(id: id, value: value))
        self.value = ""
    }

    private func answer(_ response: InstallerResponse) {
        model.respond(context.step, response)
    }
}
