import AppKit
import SwiftUI
import WGAInstallerKit

/// 설정: 환경(dev/prod), 리전, 저장소 경로. 모든 CLI 명령에 공통 옵션으로 넘어간다.
struct SettingsView: View {
    @EnvironmentObject var model: WizardModel
    private let location = InstallerLocation.fromBundle()

    var body: some View {
        Form {
            Picker("환경", selection: $model.settings.environment) {
                ForEach(["dev", "test", "prod"], id: \.self) { Text($0).tag($0) }
            }
            TextField("리전", text: $model.settings.region, prompt: Text("비우면 기본값 (서울 ap-northeast-2)"))
            HStack {
                TextField("WGA 저장소", text: $model.settings.repositoryPath, prompt: Text("deploy.sh가 있는 폴더"))
                Button("선택…", action: chooseRepository)
            }
            LabeledContent("AWS 프로필", value: model.settings.profile ?? "AWS CLI 기본값")
            TextField("알람 이메일", text: $model.settings.alarmEmail, prompt: Text("선택 (배포·GitHub 자동 배포에 사용)"))
            TextField("GitHub 저장소", text: $model.settings.githubRepository, prompt: Text("owner/repo — 비우면 git remote"))
            Toggle("dry-run (바꾸지 않고 확인만)", isOn: $model.settings.dryRun)
            Section("진단 정보") {
                LabeledContent("CLI", value: location.coreDirectory.path)
                LabeledContent("자격 증명 헬퍼", value: location.helperExecutable.path)
            }
            .font(.caption)
            .textSelection(.enabled)
        }
        .disabled(model.isAnyRunning)   // 실행 중에 설정을 바꾸면 화면과 실제 실행 옵션이 어긋난다
        .padding(20)
        .frame(width: 560)
    }

    private func chooseRepository() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.message = "WGA 저장소 폴더(deploy.sh와 cloudformation/이 있는 곳)를 고르세요"
        if panel.runModal() == .OK, let url = panel.url {
            model.settings.repositoryPath = url.path
        }
    }
}
