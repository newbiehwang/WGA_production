import AppKit
import SwiftUI
import WGAInstallerKit

/// 설정: 환경(dev/prod), 리전, 저장소 경로. 모든 CLI 명령에 공통 옵션으로 넘어간다.
struct SettingsView: View {
    @EnvironmentObject var model: WizardModel

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
        }
        .padding(20)
        .frame(width: 520)
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
