import SwiftUI
import WGAInstallerKit

/// ③~⑦ 단계 화면의 공통 틀.
/// 위에서부터: 제목·실행 버튼 → dry-run 안내 → 단계별 입력(options) → 진행 표시 → 하위 단계 → 점검 결과 →
/// dry-run에서 실행하지 않은 명령 → 오류 → 요약과 다음 단계 → 로그
struct StepScreen<Options: View>: View {
    @EnvironmentObject var model: WizardModel
    let step: WizardStep
    @ViewBuilder var options: () -> Options

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                StepHeader(step: step)
                if model.settings.dryRun && step.changesState {
                    DryRunBanner()
                }
                options()
                if let run = model.runs[step] {
                    RunDetails(step: step, run: run)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

extension StepScreen where Options == EmptyView {
    init(step: WizardStep) {
        self.step = step
        self.options = { EmptyView() }
    }
}

/// 실행 결과 전체 (진행 표시부터 로그까지)
struct RunDetails: View {
    @EnvironmentObject var model: WizardModel
    let step: WizardStep
    let run: StepRun

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if run.status == .running, let progress = run.progress {
                ProgressPanel(fraction: run.progressFraction, label: progress.label, phase: progress.phase)
            }
            if !run.substeps.isEmpty {
                SubstepList(substeps: run.substeps)
            }
            if !run.checks.isEmpty {
                CheckList(items: run.checks).frame(minHeight: CGFloat(min(run.checks.count, 8)) * 44)
            }
            if !run.dryRuns.isEmpty {
                DryRunList(items: run.dryRuns)
            }
            ErrorList(errors: run.errors)
            if run.status != .running, let summary = run.summary {
                ResultBanner(step: step, status: run.status, summary: summary)
            }
            LogView(run: run, expandedByDefault: step == .deploy)
        }
    }
}

struct DryRunBanner: View {
    var body: some View {
        Label("dry-run 모드: 현재 상태를 확인하고 실행할 명령만 보여 줍니다. AWS·GitHub에는 아무것도 바꾸지 않습니다.",
              systemImage: "eye")
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct ProgressPanel: View {
    let fraction: Double?
    let label: String
    let phase: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let fraction {
                ProgressView(value: fraction) { Text(label) } currentValueLabel: { Text(phase) }
            } else {
                HStack { ProgressView().controlSize(.small); Text(label) }
            }
        }
    }
}

struct SubstepList: View {
    let substeps: [SubStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(substeps) { substep in
                HStack(alignment: .top, spacing: 8) {
                    StatusIcon(status: substep.status)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(substep.title).bold()
                        if let summary = substep.summary {
                            Text(summary).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                    }
                }
            }
        }
    }
}

/// dry-run에서 실행하지 않고 보여 주기만 한 명령
struct DryRunList: View {
    let items: [(command: String, reason: String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("실행할 명령 (dry-run이라 실행하지 않음)").font(.headline)
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.reason).font(.callout)
                    Text(item.command)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 4))
                }
            }
        }
    }
}

/// 끝난 뒤의 결과와 다음 단계 버튼
struct ResultBanner: View {
    @EnvironmentObject var model: WizardModel
    let step: WizardStep
    let status: StepStatus
    let summary: String

    var body: some View {
        HStack {
            StatusIcon(status: status)
            Text(summary).textSelection(.enabled)
            Spacer()
            if status == .ok || status == .skipped, let next = step.next {
                Button("다음: \(next.title)") { model.selected = next }
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }
}
