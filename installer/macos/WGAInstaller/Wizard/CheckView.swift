import AppKit
import SwiftUI
import WGAInstallerKit

/// ① 시작·사전 점검: 도구 목록 체크 표시, 없는 도구의 설치 명령 복사 버튼
struct CheckView: View {
    @EnvironmentObject var model: WizardModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepHeader(step: .check)
            if model.settings.repositoryPath.isEmpty {
                Label("설정(⌘,)에서 WGA 저장소 폴더를 먼저 지정하세요", systemImage: "folder.badge.questionmark")
                    .foregroundStyle(.orange)
            }
            if let run = model.runs[.check] {
                CheckList(items: run.checks)
                ErrorList(errors: run.errors)
                if run.status != .running, let summary = run.summary {
                    ResultBanner(step: .check, status: run.status, summary: summary)
                }
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
    let step: WizardStep
    @State private var confirmingCancel = false

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(step.title).font(.title2).bold()
                Text(step.subtitle).foregroundStyle(.secondary)
            }
            Spacer()
            if model.isRunning(step) {
                Button("취소") {
                    // 실제로 상태를 바꾸는 중이면 한 번 더 묻는다 (dry-run이나 읽기 전용 단계는 바로 취소)
                    if step.changesState && !model.settings.dryRun { confirmingCancel = true } else { model.cancel(step) }
                }
            } else {
                Button(model.runs[step] == nil ? step.actionTitle : "다시 실행") { model.run(step) }
                    .keyboardShortcut(.defaultAction)
                    // 한 번에 한 단계만 실행한다 (배포 중에 정리를 시작하는 식의 겹침 방지)
                    .disabled(model.isAnyRunning)
            }
        }
        .alert("실행 중인 작업을 취소할까요?", isPresented: $confirmingCancel) {
            Button("계속 진행", role: .cancel) {}
            Button("취소", role: .destructive) { model.cancel(step) }
        } message: {
            Text("스택을 만들거나 지우는 도중에 멈추면 스택이 중간 상태로 남을 수 있습니다. "
                 + "취소한 뒤에는 같은 단계를 다시 실행하면 이어서 진행합니다.")
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
