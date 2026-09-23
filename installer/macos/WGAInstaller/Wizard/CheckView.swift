import AppKit
import SwiftUI
import WGAInstallerKit

/// ① 시작·사전 점검: 도구 목록 체크 표시, 없는 도구의 설치 명령 복사 버튼
struct CheckView: View {
    @EnvironmentObject var model: WizardModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepHeader(title: "사전 점검",
                       subtitle: "필요한 도구와 저장소, AWS·GitHub 연결 상태를 확인합니다. 아무것도 바꾸지 않습니다.",
                       step: .check)
            if let run = model.runs[.check] {
                CheckList(items: run.checks)
                ErrorList(errors: run.errors)
                if let summary = run.summary { Text(summary).font(.callout).foregroundStyle(.secondary) }
            } else {
                Spacer()
            }
        }
        .padding(20)
    }
}

/// 단계 화면 윗부분: 제목, 설명, 실행·취소 버튼
struct StepHeader: View {
    @EnvironmentObject var model: WizardModel
    let title: String
    let subtitle: String
    let step: WizardStep
    var runLabel = "점검 시작"

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.title2).bold()
                Text(subtitle).foregroundStyle(.secondary)
            }
            Spacer()
            if model.isRunning(step) {
                Button("취소") { model.cancel(step) }
            } else {
                Button(model.runs[step] == nil ? runLabel : "다시 실행") { model.run(step) }
                    .keyboardShortcut(.defaultAction)
            }
        }
    }
}

struct CheckList: View {
    let items: [CheckItem]

    var body: some View {
        List(items) { item in
            HStack(alignment: .top, spacing: 10) {
                CheckIcon(status: item.status)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).bold()
                    Text(item.detail).textSelection(.enabled)
                    if let hint = item.hint {
                        HStack {
                            Text(hint).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                            // 설치 안내(brew install ...)는 터미널에 붙여 넣을 수 있게 복사 버튼을 둔다
                            if let command = CommandHint.copyableCommand(in: hint) {
                                Button("복사") { Self.copy(command) }.controlSize(.small)
                            }
                        }
                    }
                    if let url = item.url.flatMap(URL.init(string:)) {
                        Link("열기", destination: url).font(.callout)
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

struct CheckIcon: View {
    let status: CheckStatus

    var body: some View {
        switch status {
        case .ok: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .warn: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        case .fail: Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
        case .info: Image(systemName: "info.circle.fill").foregroundStyle(.blue)
        }
    }
}

struct ErrorList: View {
    let errors: [ErrorItem]

    var body: some View {
        ForEach(Array(errors.enumerated()), id: \.offset) { _, error in
            VStack(alignment: .leading, spacing: 2) {
                Label(error.message, systemImage: "xmark.octagon.fill").foregroundStyle(.red)
                if let hint = error.hint { Text(hint).font(.callout).foregroundStyle(.secondary) }
            }
            .textSelection(.enabled)
        }
    }
}
