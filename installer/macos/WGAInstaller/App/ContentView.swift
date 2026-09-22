import SwiftUI
import WGAInstallerKit

/// 사이드바(단계 목록과 상태) + 선택한 단계 화면. CLI가 질문하면 시트로 띄운다.
struct ContentView: View {
    @EnvironmentObject var model: WizardModel

    var body: some View {
        NavigationSplitView {
            List(WizardStep.allCases, selection: $model.selected) { step in
                StepRow(step: step, status: model.status(of: step))
                    .tag(step)
                    .disabled(!step.isAvailable)
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 220)
        } detail: {
            switch model.selected {
            case .check: CheckView()
            case .aws: AwsConnectView()
            default: ComingSoonView(step: model.selected)
            }
        }
        // 질문은 한 번에 하나뿐이다 (CLI가 답을 받을 때까지 다음으로 넘어가지 않음)
        .sheet(item: Binding(get: { model.activePrompt }, set: { _ in })) { context in
            PromptSheet(context: context)
                .environmentObject(model)
        }
    }
}

struct StepRow: View {
    let step: WizardStep
    let status: StepStatus

    var body: some View {
        HStack {
            StatusIcon(status: status)
            Text(step.title)
            Spacer()
            if !step.isAvailable {
                Text("준비 중").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// 대기/진행/완료/건너뜀/실패/취소 표시
struct StatusIcon: View {
    let status: StepStatus

    var body: some View {
        switch status {
        case .idle: Image(systemName: "circle").foregroundStyle(.secondary)
        case .running: ProgressView().controlSize(.small)
        case .ok: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .skipped: Image(systemName: "arrow.uturn.right.circle.fill").foregroundStyle(.blue)
        case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        case .cancelled: Image(systemName: "stop.circle.fill").foregroundStyle(.orange)
        }
    }
}

struct ComingSoonView: View {
    let step: WizardStep

    var body: some View {
        ContentUnavailableCompat(title: step.title, message: "이 단계의 화면은 다음 버전에서 추가됩니다. "
                                 + "지금은 터미널에서 installer/core/wga-installer \(step.command)로 실행할 수 있습니다.")
    }
}

/// macOS 13에서도 쓸 수 있는 빈 화면 안내 (ContentUnavailableView는 macOS 14부터)
struct ContentUnavailableCompat: View {
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            Text(title).font(.title2).bold()
            Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 420)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
