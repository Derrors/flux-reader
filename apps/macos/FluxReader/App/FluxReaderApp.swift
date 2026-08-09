import SwiftUI

enum AppAppearance: String, CaseIterable, Identifiable {
  case system
  case light
  case dark

  static let storageKey = "fluxReader.appearance"
  static let defaultValue: AppAppearance = .light

  var id: Self { self }

  var title: String {
    switch self {
    case .system:
      "跟随系统"
    case .light:
      "浅色"
    case .dark:
      "深色"
    }
  }

  var systemImage: String {
    switch self {
    case .system:
      "circle.lefthalf.filled"
    case .light:
      "sun.max"
    case .dark:
      "moon"
    }
  }

  var preferredColorScheme: ColorScheme? {
    switch self {
    case .system:
      nil
    case .light:
      .light
    case .dark:
      .dark
    }
  }
}

@main
@MainActor
struct FluxReaderApp: App {
  @StateObject private var viewModel = ReaderViewModel()
  @AppStorage(AppAppearance.storageKey) private var appearance = AppAppearance.defaultValue

  var body: some Scene {
    WindowGroup {
      ReaderView(viewModel: viewModel, appearance: $appearance)
        .preferredColorScheme(appearance.preferredColorScheme)
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

      CommandMenu("外观") {
        Picker("外观", selection: $appearance) {
          ForEach(AppAppearance.allCases) { option in
            Label(option.title, systemImage: option.systemImage)
              .tag(option)
          }
        }
      }
    }
  }
}
