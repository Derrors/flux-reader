import SwiftUI

@main
@MainActor
struct FluxReaderApp: App {
  @StateObject private var viewModel = ReaderViewModel()

  var body: some Scene {
    WindowGroup {
      ReaderView(viewModel: viewModel)
    }
    .defaultSize(width: 1_080, height: 720)
    .commands {
      CommandGroup(replacing: .newItem) {
        Button("打开文件…") {
          viewModel.presentFileImporter()
        }
        .keyboardShortcut("o", modifiers: .command)

        Button("打开文件夹…") {
          viewModel.presentFolderImporter()
        }
        .keyboardShortcut("o", modifiers: [.command, .shift])

        Divider()

        Button("刷新全部文件夹") {
          viewModel.refreshAllWorkspaces()
        }
        .keyboardShortcut("r", modifiers: .command)
        .disabled(viewModel.workspaces.isEmpty)

        Button("关闭全部文件夹") {
          viewModel.closeAllWorkspaces()
        }
        .disabled(viewModel.workspaces.isEmpty)
      }
    }
  }
}
