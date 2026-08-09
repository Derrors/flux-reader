import Combine
import Foundation

@MainActor
final class ReaderViewModel: ObservableObject {
  enum Phase {
    case empty
    case loading(String)
    case loaded(MarkdownDocument)
    case failure(String)
  }

  @Published private(set) var phase: Phase = .empty
  @Published private(set) var workspaces: [WorkspaceSnapshot] = []
  @Published private(set) var recentDocuments: [RecentDocument] = []
  @Published private(set) var loadingWorkspaceURLs: Set<URL> = []
  @Published private(set) var workspaceMessages: [URL: String] = [:]
  @Published private(set) var libraryMessage: String?
  @Published private(set) var searchResults: [WorkspaceSearchResult] = []
  @Published private(set) var isSearching = false
  @Published var searchQuery = "" {
    didSet { scheduleSearch() }
  }
  @Published var isFileImporterPresented = false
  @Published var isFolderImporterPresented = false

  private let fileService: any FileAccessing
  private let folderService: any FolderIndexing
  private let bookmarkStore: any BookmarkStoring
  private let workspaceWatcher: any WorkspaceWatching
  private let searchService: any WorkspaceSearching
  private var loadTask: Task<Void, Never>?
  private var searchTask: Task<Void, Never>?
  private var workspaceTasks: [URL: Task<Void, Never>] = [:]
  private var workspaceIndexTasks: [URL: Task<WorkspaceSnapshot, Error>] = [:]
  private var workspaceOperationIDs: [URL: UUID] = [:]
  private var workspaceSnapshots: [URL: WorkspaceSnapshot] = [:]
  private var workspaceOrder: [URL] = []
  private var workspaceAccesses: [URL: SecurityScopedAccess] = [:]
  private var workspaceWatchTokens: [URL: any WorkspaceWatchToken] = [:]
  private var autoRefreshTasks: [URL: Task<Void, Never>] = [:]
  private var didRestoreLibrary = false

  init(
    fileService: any FileAccessing = LocalFileService(),
    folderService: any FolderIndexing = LocalFolderIndexService(),
    bookmarkStore: any BookmarkStoring = SecurityScopedBookmarkStore(),
    workspaceWatcher: any WorkspaceWatching = FSEventWorkspaceWatcher(),
    searchService: any WorkspaceSearching = LocalWorkspaceSearchService()
  ) {
    self.fileService = fileService
    self.folderService = folderService
    self.bookmarkStore = bookmarkStore
    self.workspaceWatcher = workspaceWatcher
    self.searchService = searchService
  }

  var currentDocument: MarkdownDocument? {
    guard case .loaded(let document) = phase else { return nil }
    return document
  }

  var isWorkspaceLoading: Bool {
    !loadingWorkspaceURLs.isEmpty
  }

  func isWorkspaceLoading(_ workspace: WorkspaceSnapshot) -> Bool {
    loadingWorkspaceURLs.contains(workspace.id)
  }

  func message(for workspace: WorkspaceSnapshot) -> String? {
    workspaceMessages[workspace.id]
  }

  func restoreLibraryIfNeeded() {
    guard !didRestoreLibrary else { return }
    didRestoreLibrary = true

    #if DEBUG
      if restoreUITestDocumentIfPresent() { return }
    #endif

    refreshRecentDocuments()

    let restoredURLs = bookmarkStore.restoreWorkspaces()
    workspaceOrder = restoredURLs.map(\.standardizedFileURL)
    for url in restoredURLs {
      loadWorkspace(at: url, reason: .restore)
    }
  }

  func presentFileImporter() {
    isFileImporterPresented = true
  }

  func presentFolderImporter() {
    isFolderImporterPresented = true
  }

  func handleImportResult(_ result: Result<[URL], Error>) {
    handleImporterResult(result) { [weak self] urls in
      guard let self, let url = urls.first else { return }
      open(url)
    }
  }

  func handleFolderImportResult(_ result: Result<[URL], Error>) {
    handleImporterResult(result) { [weak self] urls in
      guard let self else { return }
      for url in urls {
        loadWorkspace(at: url, reason: .open)
      }
    }
  }

  func open(_ url: URL) {
    loadDocument(at: url, recordsRecentDocument: true)
  }

  func openSearchResult(_ result: WorkspaceSearchResult) {
    loadDocument(
      at: result.documentURL,
      recordsRecentDocument: true,
      preferredResourceRootURL: result.workspaceRootURL
    )
  }

  func openRecentDocument(_ document: RecentDocument) {
    open(document.url)
  }

  func removeRecentDocument(_ document: RecentDocument) {
    bookmarkStore.removeRecentDocument(document.url)
    refreshRecentDocuments()
  }

  func clearRecentDocuments() {
    bookmarkStore.clearRecentDocuments()
    recentDocuments = []
  }

  func refreshWorkspace(_ workspace: WorkspaceSnapshot) {
    loadWorkspace(at: workspace.rootURL, reason: .refresh)
  }

  func refreshAllWorkspaces() {
    for workspace in workspaces {
      refreshWorkspace(workspace)
    }
  }

  func closeWorkspace(_ workspace: WorkspaceSnapshot) {
    closeWorkspace(at: workspace.rootURL, removesBookmark: true)
  }

  func closeAllWorkspaces() {
    let rootURLs = workspaceOrder
    for rootURL in rootURLs {
      closeWorkspace(at: rootURL, removesBookmark: false)
    }
    bookmarkStore.clearWorkspaces()
    libraryMessage = nil
  }

  func handleDrop(_ urls: [URL]) -> Bool {
    let documentURLs = urls.filter(MarkdownDocument.supports)
    if let documentURL = documentURLs.first {
      open(documentURL)
      return true
    }

    let folderURLs = urls.filter {
      (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
    }
    guard !folderURLs.isEmpty else { return false }
    for folderURL in folderURLs {
      loadWorkspace(at: folderURL, reason: .open)
    }
    return true
  }

  private func handleImporterResult(
    _ result: Result<[URL], Error>,
    onSuccess: ([URL]) -> Void
  ) {
    switch result {
    case .success(let urls):
      onSuccess(urls)
    case .failure(let error):
      let cocoaError = error as NSError
      guard cocoaError.code != NSUserCancelledError else { return }
      phase = .failure(error.localizedDescription)
    }
  }

  private func loadDocument(
    at url: URL,
    recordsRecentDocument: Bool,
    preferredResourceRootURL: URL? = nil
  ) {
    guard MarkdownDocument.supports(url) else {
      phase = .failure(
        FileAccessError.unsupportedFileType(url.pathExtension).localizedDescription
      )
      return
    }

    if recordsRecentDocument {
      recordRecentDocument(url)
    }
    loadTask?.cancel()
    phase = .loading(url.lastPathComponent)

    let resourceRootURL = preferredResourceRootURL ?? containingWorkspaceRoot(for: url)
    let fileService = self.fileService
    loadTask = Task { [weak self] in
      do {
        let document = try await Task.detached(priority: .userInitiated) {
          try fileService.loadDocument(at: url)
        }.value
        guard !Task.isCancelled else { return }
        self?.phase = .loaded(document.withResourceRoot(resourceRootURL))
      } catch {
        guard !Task.isCancelled else { return }
        self?.phase = .failure(error.localizedDescription)
      }
    }
  }

  private func loadWorkspace(at url: URL, reason: WorkspaceLoadReason) {
    let key = url.standardizedFileURL
    workspaceTasks[key]?.cancel()
    workspaceIndexTasks[key]?.cancel()
    loadingWorkspaceURLs.insert(key)
    workspaceMessages[key] = nil
    libraryMessage = nil

    let candidateAccess = workspaceAccesses[key] ?? SecurityScopedAccess(url: url)
    let candidateURL = candidateAccess.url
    let folderService = self.folderService
    let indexTask = Task.detached(priority: .userInitiated) {
      try folderService.indexFolder(at: candidateURL)
    }
    let operationID = UUID()
    workspaceOperationIDs[key] = operationID
    workspaceIndexTasks[key] = indexTask
    workspaceTasks[key] = Task { [weak self] in
      do {
        let snapshot = try await indexTask.value
        guard !Task.isCancelled, let self else { return }
        guard workspaceOperationIDs[key] == operationID else { return }

        var warning: String?
        if reason.persistsBookmark {
          do {
            try bookmarkStore.saveWorkspace(url)
          } catch {
            bookmarkStore.removeWorkspace(url)
            warning = "文件夹已打开，但无法保存下次启动所需的授权。"
          }
        }

        if reason.movesWorkspaceToFront {
          workspaceOrder.removeAll { $0 == key }
          workspaceOrder.insert(key, at: 0)
        } else if !workspaceOrder.contains(key) {
          workspaceOrder.append(key)
        }
        workspaceSnapshots[key] = snapshot
        workspaceAccesses[key] = candidateAccess
        updatePublishedWorkspaces()

        if workspaceWatchTokens[key] == nil {
          do {
            workspaceWatchTokens[key] = try makeWatchToken(rootURL: candidateURL)
          } catch {
            warning = [warning, error.localizedDescription]
              .compactMap { $0 }
              .joined(separator: " ")
          }
        }
        workspaceMessages[key] = warning
        finishWorkspaceOperation(key: key, operationID: operationID)
        scheduleSearch(delay: .zero)

        if reason.reloadsCurrentDocument {
          reloadCurrentDocumentIfNeeded(in: snapshot.rootURL)
        }
      } catch is CancellationError {
        return
      } catch {
        guard !Task.isCancelled, let self else { return }
        guard workspaceOperationIDs[key] == operationID else { return }
        if reason.removesBookmarkOnFailure {
          bookmarkStore.removeWorkspace(url)
          workspaceOrder.removeAll { $0 == key }
        }
        if workspaceSnapshots[key] == nil {
          libraryMessage = error.localizedDescription
        } else {
          workspaceMessages[key] = error.localizedDescription
        }
        finishWorkspaceOperation(key: key, operationID: operationID)
      }
    }
  }

  private func finishWorkspaceOperation(key: URL, operationID: UUID) {
    guard workspaceOperationIDs[key] == operationID else { return }
    loadingWorkspaceURLs.remove(key)
    workspaceOperationIDs[key] = nil
    workspaceTasks[key] = nil
    workspaceIndexTasks[key] = nil
  }

  private func makeWatchToken(rootURL: URL) throws -> any WorkspaceWatchToken {
    try workspaceWatcher.watch(rootURL: rootURL) { [weak self] in
      Task { @MainActor [weak self] in
        self?.scheduleAutomaticRefresh(rootURL: rootURL)
      }
    }
  }

  private func scheduleAutomaticRefresh(rootURL: URL) {
    let key = rootURL.standardizedFileURL
    guard workspaceSnapshots[key] != nil else { return }
    autoRefreshTasks[key]?.cancel()
    autoRefreshTasks[key] = Task { [weak self] in
      do {
        try await Task.sleep(for: .milliseconds(450))
      } catch {
        return
      }
      guard let self, !Task.isCancelled else { return }
      autoRefreshTasks[key] = nil
      loadWorkspace(at: rootURL, reason: .automatic)
    }
  }

  private func reloadCurrentDocumentIfNeeded(in rootURL: URL) {
    guard let document = currentDocument else { return }
    guard Self.contains(document.url, in: rootURL) else { return }
    loadDocument(
      at: document.url,
      recordsRecentDocument: false,
      preferredResourceRootURL: rootURL
    )
  }

  private func closeWorkspace(at rootURL: URL, removesBookmark: Bool) {
    let key = rootURL.standardizedFileURL
    workspaceTasks.removeValue(forKey: key)?.cancel()
    workspaceIndexTasks.removeValue(forKey: key)?.cancel()
    autoRefreshTasks.removeValue(forKey: key)?.cancel()
    workspaceWatchTokens.removeValue(forKey: key)?.cancel()
    workspaceOperationIDs[key] = nil
    workspaceSnapshots[key] = nil
    workspaceAccesses[key] = nil
    workspaceMessages[key] = nil
    loadingWorkspaceURLs.remove(key)
    workspaceOrder.removeAll { $0 == key }
    updatePublishedWorkspaces()
    scheduleSearch(delay: .zero)

    if removesBookmark {
      bookmarkStore.removeWorkspace(rootURL)
    }
    if let document = currentDocument, Self.contains(document.url, in: rootURL) {
      if let remainingRootURL = containingWorkspaceRoot(for: document.url) {
        phase = .loaded(document.withResourceRoot(remainingRootURL))
      } else {
        loadTask?.cancel()
        phase = .empty
      }
    }
  }

  private func scheduleSearch(delay: Duration = .milliseconds(220)) {
    searchTask?.cancel()
    let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else {
      searchResults = []
      isSearching = false
      return
    }

    isSearching = true
    let workspaces = self.workspaces
    let searchService = self.searchService
    searchTask = Task { [weak self] in
      do {
        if delay != .zero {
          try await Task.sleep(for: delay)
        }
        let results = try await Task.detached(priority: .userInitiated) {
          try searchService.search(query: query, workspaces: workspaces)
        }.value
        guard !Task.isCancelled, let self else { return }
        searchResults = results
        isSearching = false
      } catch is CancellationError {
        return
      } catch {
        guard !Task.isCancelled, let self else { return }
        searchResults = []
        isSearching = false
        libraryMessage = error.localizedDescription
      }
    }
  }

  private func updatePublishedWorkspaces() {
    workspaces = workspaceOrder.compactMap { workspaceSnapshots[$0] }
  }

  private func containingWorkspaceRoot(for url: URL) -> URL? {
    workspaces
      .map(\.rootURL)
      .filter { Self.contains(url, in: $0) }
      .max {
        $0.path(percentEncoded: false).count < $1.path(percentEncoded: false).count
      }
  }

  private func recordRecentDocument(_ url: URL) {
    try? bookmarkStore.recordRecentDocument(url)
    refreshRecentDocuments()
  }

  private func refreshRecentDocuments() {
    recentDocuments = bookmarkStore.restoreRecentDocuments()
  }

  private static func contains(_ candidateURL: URL, in rootURL: URL) -> Bool {
    let rootPath = rootURL.standardizedFileURL.path(percentEncoded: false)
    let candidatePath = candidateURL.standardizedFileURL.path(percentEncoded: false)
    let boundary = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
    return candidatePath.hasPrefix(boundary)
  }

  #if DEBUG
    private func restoreUITestDocumentIfPresent() -> Bool {
      let environment = ProcessInfo.processInfo.environment
      guard
        environment["FLUX_READER_UI_TESTING"] == "1",
        let content = environment["FLUX_READER_UI_TEST_MARKDOWN"]
      else { return false }

      let url = URL(fileURLWithPath: "/FluxReaderUITest.md")
      phase = .loaded(
        MarkdownDocument(
          url: url,
          content: content,
          byteCount: Data(content.utf8).count,
          modificationDate: nil
        )
      )
      return true
    }
  #endif
}

private enum WorkspaceLoadReason {
  case open
  case restore
  case refresh
  case automatic

  var persistsBookmark: Bool { self == .open }
  var movesWorkspaceToFront: Bool { self == .open }
  var removesBookmarkOnFailure: Bool { self == .restore }
  var reloadsCurrentDocument: Bool { self == .refresh || self == .automatic }
}
