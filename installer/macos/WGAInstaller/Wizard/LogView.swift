import AppKit
import SwiftUI
import WGAInstallerKit

/// 실행 로그: 검색, 전체 복사, 새 줄이 오면 맨 아래로 따라가기.
/// CLI가 이미 비밀 값을 ***로 가린 뒤 보내므로, 여기 보이는 내용을 복사해 공유해도 된다.
struct LogView: View {
    let run: StepRun
    let expandedByDefault: Bool
    @State private var query = ""
    @State private var expanded: Bool?

    var body: some View {
        DisclosureGroup(isExpanded: Binding(get: { expanded ?? expandedByDefault }, set: { expanded = $0 })) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    TextField("로그 검색", text: $query)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 260)
                    Spacer()
                    Button("전체 복사") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(run.logText, forType: .string)
                    }
                    .disabled(run.logs.isEmpty)
                }
                LogLines(lines: run.logs(matching: query), follow: query.isEmpty)
                    .frame(minHeight: 160, maxHeight: 360)
            }
        } label: {
            Text("로그 (\(run.logs.count)줄)").font(.headline)
        }
    }
}

struct LogLines: View {
    let lines: [LogLine]
    let follow: Bool   // 검색 중이 아니면 새 줄이 올 때 맨 아래로 스크롤

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(lines) { line in
                        Text(line.text)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(color(line.stream))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(line.id)
                    }
                }
                .textSelection(.enabled)
                .padding(6)
            }
            .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            .onChange(of: lines.last?.id) { last in
                if follow, let last { proxy.scrollTo(last, anchor: .bottom) }
            }
        }
    }

    private func color(_ stream: String) -> Color {
        switch stream {
        case "stderr": return .orange
        case "info": return .blue
        default: return .primary
        }
    }
}
