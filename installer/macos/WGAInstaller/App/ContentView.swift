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
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 220)
            .safeAreaInset(edge: .bottom) { EnvironmentBadge().padding(10) }
        } detail: {
            switch model.selected {
            case .check: CheckView()
            case .aws: AwsConnectView()
            case .setup: SetupView()
            case .deploy: DeployView()
            case .verify: VerifyView()
            case .oidc: OidcView()
            case .teardown: TeardownView()
            }
        }
        .toolbar {
            ToolbarItem {
                // dry-run: 모든 단계에서 상태 확인만 하고 바꾸지 않는다 (전 과정을 안전하게 미리 보기)
                Toggle(isOn: $model.settings.dryRun) { Label("dry-run", systemImage: "eye") }
                    .toggleStyle(.button)
                    .help("켜면 모든 단계가 현재 상태만 확인하고, 실행할 명령을 보여 주기만 합니다")
                    .disabled(model.isAnyRunning)
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
        }
    }
}

/// 사이드바 아래: 지금 어느 환경·리전·프로필에 작업하는지 (prod는 눈에 띄게)
struct EnvironmentBadge: View {
    @EnvironmentObject var model: WizardModel

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("환경 \(model.settings.environment)")
                .bold()
                .foregroundStyle(model.settings.environment == "prod" ? .red : .primary)
            Text("리전 \(model.settings.region.isEmpty ? "기본값" : model.settings.region)")
            Text("프로필 \(model.settings.profile ?? "기본값")")
            if model.settings.dryRun { Text("dry-run 켜짐").foregroundStyle(.blue) }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
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
