import SwiftUI
import UniformTypeIdentifiers

struct ReaderView: View {
  @ObservedObject var viewModel: ReaderViewModel
  @Binding var appearance: AppAppearance

  var body: some View {
    NavigationSplitView {
      sidebar
    } detail: {
      detail
        .navigationTitle(viewModel.currentDocument?.displayName ?? "Flux Reader")
    }
    .navigationSplitViewStyle(.balanced)
    .frame(minWidth: 860, minHeight: 580)
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        Menu {
          Picker("外观", selection: $appearance) {
            ForEach(AppAppearance.allCases) { option in
              Label(option.title, systemImage: option.systemImage)
                .tag(option)
            }
          }
        } label: {
          Label("外观", systemImage: appearance.systemImage)
        }
        .help("切换跟随系统、浅色或深色外观")
        .accessibilityIdentifier("flux.appearance")
        .accessibilityValue(appearance.title)

        if !viewModel.workspaces.isEmpty {
          Button {
            viewModel.refreshAllWorkspaces()
          } label: {
            Label("刷新文件夹", systemImage: "arrow.clockwise")
          }
          .help("立即刷新全部文件夹；平时会自动监听变化")
        }

        Button {
          viewModel.presentFolderImporter()
        } label: {
          Label("打开文件夹", systemImage: "folder.badge.plus")
        }
        .help("打开 Markdown 文件夹")

        Button {
          viewModel.presentFileImporter()
        } label: {
          Label("打开文件", systemImage: "doc.badge.plus")
        }
        .help("打开 Markdown 文稿")
      }
    }
    .fileImporter(
      isPresented: $viewModel.isImporterPresented,
      allowedContentTypes: viewModel.importerRequest == .document
        ? MarkdownContentType.allowedContentTypes : [.folder],
      allowsMultipleSelection: viewModel.importerRequest == .folders,
      onCompletion: viewModel.handleImporterResult
    )
    .onOpenURL(perform: viewModel.open)
    .dropDestination(for: URL.self) { urls, _ in
      viewModel.handleDrop(urls)
    }
    .task {
      viewModel.restoreLibraryIfNeeded()
    }
    .searchable(
      text: $viewModel.searchQuery,
      placement: .sidebar,
      prompt: "搜索文件名和正文"
    )
  }

  private var sidebar: some View {
    List {
      Section("当前文稿") {
        if let document = viewModel.currentDocument {
          Label(document.displayName, systemImage: "doc.text")
            .lineLimit(1)
            .help(document.url.path(percentEncoded: false))
            .accessibilityIdentifier("flux.current-document")
        } else {
          Label("尚未打开", systemImage: "doc")
            .foregroundStyle(.secondary)
        }
      }

      if !viewModel.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        searchResultsSection
      }

      workspaceSection

      if !viewModel.recentDocuments.isEmpty {
        Section("最近文稿") {
          ForEach(viewModel.recentDocuments) { document in
            Button {
              viewModel.openRecentDocument(document)
            } label: {
              Label(document.displayName, systemImage: "clock")
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .help(document.url.path(percentEncoded: false))
            .contextMenu {
              Button("从最近文稿移除") {
                viewModel.removeRecentDocument(document)
              }
            }
          }

          Button("清除最近记录", role: .destructive) {
            viewModel.clearRecentDocuments()
          }
          .font(.caption)
        }
      }
    }
    .accessibilityIdentifier("flux.sidebar")
    .navigationTitle("Flux Reader")
    .navigationSplitViewColumnWidth(min: 220, ideal: 280, max: 380)
  }

  @ViewBuilder
  private var workspaceSection: some View {
    Section("文件夹") {
      ForEach(viewModel.workspaces) { workspace in
        HStack(spacing: 8) {
          Label(workspace.displayName, systemImage: "folder.fill")
            .lineLimit(1)
            .help(workspace.rootURL.path(percentEncoded: false))

          Spacer()

          if viewModel.isWorkspaceLoading(workspace) {
            ProgressView()
              .controlSize(.mini)
          }

          Button {
            viewModel.refreshWorkspace(workspace)
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .buttonStyle(.borderless)
          .help("立即刷新文件夹")

          Button {
            viewModel.closeWorkspace(workspace)
          } label: {
            Image(systemName: "xmark.circle")
          }
          .buttonStyle(.borderless)
          .help("关闭文件夹并移除持久授权")
        }
        .accessibilityIdentifier("flux.workspace.\(workspace.displayName)")

        if workspace.children.isEmpty {
          Text("没有找到 Markdown 文稿")
            .font(.caption)
            .foregroundStyle(.secondary)
        } else {
          OutlineGroup(workspace.children, children: \.outlineChildren) { node in
            workspaceNode(node)
          }
        }

        Text("共 \(workspace.documentCount) 份文稿 · 自动监听")
          .font(.caption2)
          .foregroundStyle(.tertiary)

        if let message = viewModel.message(for: workspace) {
          Label(message, systemImage: "exclamationmark.triangle")
            .font(.caption)
            .foregroundStyle(.orange)
        }
      }

      if viewModel.workspaces.isEmpty && !viewModel.isWorkspaceLoading {
        Button {
          viewModel.presentFolderImporter()
        } label: {
          Label("打开文件夹…", systemImage: "folder.badge.plus")
        }
        .buttonStyle(.plain)
      }

      if viewModel.isWorkspaceLoading && viewModel.workspaces.isEmpty {
        HStack(spacing: 8) {
          ProgressView()
            .controlSize(.small)
          Text("正在扫描 Markdown 文稿…")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      if let message = viewModel.libraryMessage {
        Label(message, systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(.orange)
      }

      if viewModel.workspaces.count > 1 {
        Button("关闭全部文件夹", role: .destructive) {
          viewModel.closeAllWorkspaces()
        }
        .font(.caption)
      }
    }
  }

  @ViewBuilder
  private var searchResultsSection: some View {
    Section("搜索结果") {
      if viewModel.isSearching {
        HStack(spacing: 8) {
          ProgressView()
            .controlSize(.small)
          Text("正在搜索文件名和正文…")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      } else if viewModel.searchResults.isEmpty {
        Text("没有匹配的文稿")
          .font(.caption)
          .foregroundStyle(.secondary)
      } else {
        ForEach(viewModel.searchResults) { result in
          Button {
            viewModel.openSearchResult(result)
          } label: {
            VStack(alignment: .leading, spacing: 2) {
              Label(
                result.displayName,
                systemImage: result.matchKind == .fileName
                  ? "doc.text.magnifyingglass" : "text.magnifyingglass"
              )
              .lineLimit(1)

              Text(result.relativePath)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)

              if result.matchKind == .content {
                Text(result.snippet)
                  .font(.caption2)
                  .foregroundStyle(.tertiary)
                  .lineLimit(2)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(.plain)
          .help(result.documentURL.path(percentEncoded: false))
        }
      }
    }
    .accessibilityIdentifier("flux.search.results")
  }

  @ViewBuilder
  private func workspaceNode(_ node: WorkspaceNode) -> some View {
    switch node.kind {
    case .folder:
      Label(node.name, systemImage: "folder")
        .lineLimit(1)
        .help(node.url.path(percentEncoded: false))
    case .document:
      Button {
        viewModel.open(node.url)
      } label: {
        Label(node.name, systemImage: "doc.text")
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .buttonStyle(.plain)
      .foregroundStyle(
        viewModel.currentDocument?.id == node.id ? Color.accentColor : Color.primary
      )
      .help(node.url.path(percentEncoded: false))
    }
  }

  @ViewBuilder
  private var detail: some View {
    switch viewModel.phase {
    case .empty:
      placeholder
    case .loading(let fileName):
      VStack(spacing: 14) {
        ProgressView()
          .controlSize(.large)
        Text("正在打开 \(fileName)…")
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .loaded(let document):
      MarkdownRendererView(document: document)
    case .failure(let message):
      VStack(spacing: 16) {
        Image(systemName: "exclamationmark.triangle")
          .font(.system(size: 36))
          .foregroundStyle(.orange)
        Text("无法打开文稿")
          .font(.title2.weight(.semibold))
        Text(message)
          .multilineTextAlignment(.center)
          .foregroundStyle(.secondary)
          .frame(maxWidth: 480)
        Button("选择其他文件") {
          viewModel.presentFileImporter()
        }
      }
      .padding(32)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private var placeholder: some View {
    VStack(spacing: 16) {
      Image(systemName: "doc.text.magnifyingglass")
        .font(.system(size: 42))
        .foregroundStyle(.secondary)
      Text("打开 Markdown 文稿")
        .font(.title2.weight(.semibold))
        .accessibilityIdentifier("flux.empty-title")
      Text("选择或拖入 .md、.markdown、.mdx 文件，也可以打开整个文件夹。")
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)

      HStack(spacing: 10) {
        Button("打开文件…") {
          viewModel.presentFileImporter()
        }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("flux.open-file")

        Button("打开文件夹…") {
          viewModel.presentFolderImporter()
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("flux.open-folder")
      }
    }
    .padding(32)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
