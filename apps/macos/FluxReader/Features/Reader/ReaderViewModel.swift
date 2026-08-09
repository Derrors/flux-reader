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

  enum ImporterRequest: Equatable {
    case document
    case folders
  }

  private struct PendingDocumentOpen {
    let url: URL
    let recordsRecentDocument: Bool
    let preferredResourceRootURL: URL?
    let preservesEditingState: Bool
  }

  private struct SaveTargetSnapshot {
    let exists: Bool
    let modificationDate: Date?
    let content: String?
  }

  @Published private(set) var phase: Phase = .empty
  @Published private(set) var workspaces: [WorkspaceSnapshot] = []
  @Published private(set) var recentDocuments: [RecentDocument] = []
  @Published private(set) var loadingWorkspaceURLs: Set<URL> = []
  @Published private(set) var workspaceMessages: [URL: String] = [:]
  @Published private(set) var libraryMessage: String?
  @Published private(set) var searchResults: [WorkspaceSearchResult] = []
  @Published private(set) var isSearching = false
  @Published var draftContent = "" {
    didSet {
      if draftContent != currentDocument?.content, saveStatusMessage != nil {
        saveStatusMessage = nil
      }
    }
  }
  @Published private(set) var isEditing = false
  @Published private(set) var isSaving = false
  @Published private(set) var saveStatusMessage: String?
  @Published private(set) var saveErrorMessage: String?
  @Published var isUnsavedChangesConfirmationPresented = false
  @Published private(set) var saveAsRequestID = 0
  @Published var searchQuery = "" {
    didSet { scheduleSearch() }
  }
  @Published private(set) var importerRequest: ImporterRequest = .document
  @Published var isImporterPresented = false

  private let fileService: any FileAccessing
  private let folderService: any FolderIndexing
  private let bookmarkStore: any BookmarkStoring
  private let workspaceWatcher: any WorkspaceWatching
  private let searchService: any WorkspaceSearching
  private var loadTask: Task<Void, Never>?
  private var saveTask: Task<Void, Never>?
  private var saveOperationID: UUID?
  private var searchTask: Task<Void, Never>?
  private var workspaceTasks: [URL: Task<Void, Never>] = [:]
  private var workspaceIndexTasks: [URL: Task<WorkspaceSnapshot, Error>] = [:]
  private var workspaceOperationIDs: [URL: UUID] = [:]
  private var workspaceSnapshots: [URL: WorkspaceSnapshot] = [:]
  private var workspaceOrder: [URL] = []
  private var workspaceAccesses: [URL: SecurityScopedAccess] = [:]
  private var workspaceWatchTokens: [URL: any WorkspaceWatchToken] = [:]
  private var autoRefreshTasks: [URL: Task<Void, Never>] = [:]
  private var currentDocumentAccess: SecurityScopedAccess?
  private var pendingDocumentOpen: PendingDocumentOpen?
  private var opensPendingDocumentAfterSave = false
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

  var previewDocument: MarkdownDocument? {
    currentDocument?.withContent(draftContent)
  }

  var hasUnsavedChanges: Bool {
    guard let currentDocument else { return false }
    return draftContent != currentDocument.content
  }

  var canSave: Bool {
    currentDocument != nil && hasUnsavedChanges && !isSaving
  }

  var canSaveAs: Bool {
    currentDocument != nil && !isSaving
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
    importerRequest = .document
    isImporterPresented = true
  }

  func presentFolderImporter() {
    importerRequest = .folders
    isImporterPresented = true
  }

  func toggleEditing() {
    guard currentDocument != nil else { return }
    isEditing.toggle()
  }

  func save() {
    guard let document = currentDocument, hasUnsavedChanges else { return }
    performSave(
      to: document.url,
      expectedModificationDate: document.modificationDate,
      expectedContent: document.content,
      expectedTargetExists: true
    )
  }

  func requestSaveAs() {
    guard canSaveAs else { return }
    saveAsRequestID += 1
  }

  func saveAs(to url: URL, for sourceDocumentURL: URL) {
    guard
      let document = currentDocument,
      document.url.standardizedFileURL == sourceDocumentURL.standardizedFileURL
    else {
      saveErrorMessage = "另存为期间当前文稿已改变，请重新选择保存位置。"
      return
    }
    let destinationURL = url.standardizedFileURL
    let snapshot: SaveTargetSnapshot
    do {
      snapshot =
        destinationURL == document.url.standardizedFileURL
        ? SaveTargetSnapshot(
          exists: true,
          modificationDate: document.modificationDate,
          content: document.content
        )
        : try snapshotSaveTarget(at: destinationURL)
    } catch {
      saveErrorMessage = error.localizedDescription
      return
    }
    performSave(
      to: url,
      expectedModificationDate: snapshot.modificationDate,
      expectedContent: snapshot.content,
      expectedTargetExists: snapshot.exists
    )
  }

  func revertDraft() {
    guard let document = currentDocument else { return }
    draftContent = document.content
    saveStatusMessage = nil
  }

  func reloadFromDisk() {
    guard let document = currentDocument else { return }
    requestDocumentOpen(
      at: document.url,
      recordsRecentDocument: false,
      preferredResourceRootURL: document.resourceRootURL,
      allowsReloadingCurrentDocument: true,
      preservesEditingState: true
    )
  }

  func dismissSaveError() {
    saveErrorMessage = nil
  }

  func saveAndOpenPendingDocument() {
    guard pendingDocumentOpen != nil else {
      isUnsavedChangesConfirmationPresented = false
      return
    }
    isUnsavedChangesConfirmationPresented = false
    guard hasUnsavedChanges else {
      openPendingDocument()
      return
    }
    opensPendingDocumentAfterSave = true
    save()
  }

  func discardChangesAndOpenPendingDocument() {
    isUnsavedChangesConfirmationPresented = false
    opensPendingDocumentAfterSave = false
    openPendingDocument()
  }

  func cancelPendingDocumentOpen() {
    isUnsavedChangesConfirmationPresented = false
    opensPendingDocumentAfterSave = false
    pendingDocumentOpen = nil
  }

  func handleImporterResult(_ result: Result<[URL], Error>) {
    let request = importerRequest
    isImporterPresented = false

    resolveImporterResult(result) { [weak self] urls in
      guard let self else { return }
      switch request {
      case .document:
        guard let url = urls.first else { return }
        open(url)
      case .folders:
        for url in urls {
          loadWorkspace(at: url, reason: .open)
        }
      }
    }
  }

  func open(_ url: URL) {
    requestDocumentOpen(
      at: url,
      recordsRecentDocument: true,
      preferredResourceRootURL: nil
    )
  }

  func openSearchResult(_ result: WorkspaceSearchResult) {
    requestDocumentOpen(
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
    guard canCloseWorkspaceContainingCurrentDocument(workspace.rootURL) else { return }
    closeWorkspace(at: workspace.rootURL, removesBookmark: true)
  }

  func closeAllWorkspaces() {
    if hasUnsavedChanges,
      let document = currentDocument,
      workspaces.contains(where: { Self.contains(document.url, in: $0.rootURL) })
    {
      saveErrorMessage = "当前文稿有未保存的更改，请先保存或还原后再关闭文件夹。"
      return
    }
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

  private func resolveImporterResult(
    _ result: Result<[URL], Error>,
    onSuccess: ([URL]) -> Void
  ) {
    switch result {
    case .success(let urls):
      onSuccess(urls)
    case .failure(let error):
      let cocoaError = error as NSError
      guard cocoaError.code != NSUserCancelledError else { return }
      if currentDocument != nil {
        saveErrorMessage = error.localizedDescription
      } else {
        phase = .failure(error.localizedDescription)
      }
    }
  }

  private func requestDocumentOpen(
    at url: URL,
    recordsRecentDocument: Bool,
    preferredResourceRootURL: URL?,
    allowsReloadingCurrentDocument: Bool = false,
    preservesEditingState: Bool = false
  ) {
    if !allowsReloadingCurrentDocument,
      currentDocument?.url.standardizedFileURL == url.standardizedFileURL
    {
      return
    }

    let request = PendingDocumentOpen(
      url: url,
      recordsRecentDocument: recordsRecentDocument,
      preferredResourceRootURL: preferredResourceRootURL,
      preservesEditingState: preservesEditingState
    )

    if isSaving {
      pendingDocumentOpen = request
      opensPendingDocumentAfterSave = true
      return
    }

    guard hasUnsavedChanges else {
      loadDocument(
        at: url,
        recordsRecentDocument: recordsRecentDocument,
        preferredResourceRootURL: preferredResourceRootURL,
        preservesEditingState: preservesEditingState
      )
      return
    }

    pendingDocumentOpen = request
    isUnsavedChangesConfirmationPresented = true
  }

  private func openPendingDocument() {
    guard let request = pendingDocumentOpen else { return }
    pendingDocumentOpen = nil
    opensPendingDocumentAfterSave = false
    loadDocument(
      at: request.url,
      recordsRecentDocument: request.recordsRecentDocument,
      preferredResourceRootURL: request.preferredResourceRootURL,
      preservesEditingState: request.preservesEditingState
    )
  }

  private func loadDocument(
    at url: URL,
    recordsRecentDocument: Bool,
    preferredResourceRootURL: URL? = nil,
    preservesEditingState: Bool = false
  ) {
    guard MarkdownDocument.supports(url) else {
      phase = .failure(
        FileAccessError.unsupportedFileType(url.pathExtension).localizedDescription
      )
      return
    }

    let candidateAccess =
      currentDocument?.url.standardizedFileURL == url.standardizedFileURL
      ? currentDocumentAccess ?? SecurityScopedAccess(url: url)
      : SecurityScopedAccess(url: url)
    let candidateURL = candidateAccess.url
    if recordsRecentDocument { recordRecentDocument(url) }
    loadTask?.cancel()
    phase = .loading(url.lastPathComponent)

    let resourceRootURL = preferredResourceRootURL ?? containingWorkspaceRoot(for: candidateURL)
    let editingState = preservesEditingState && isEditing
    let fileService = self.fileService
    loadTask = Task { [weak self] in
      do {
        let document = try await Task.detached(priority: .userInitiated) {
          try fileService.loadDocument(at: candidateURL)
        }.value
        guard !Task.isCancelled, let self else { return }
        applyLoadedDocument(
          document.withResourceRoot(resourceRootURL),
          access: candidateAccess,
          isEditing: editingState
        )
      } catch {
        guard !Task.isCancelled else { return }
        self?.phase = .failure(error.localizedDescription)
      }
    }
  }

  private func applyLoadedDocument(
    _ document: MarkdownDocument,
    access: SecurityScopedAccess?,
    isEditing: Bool = false
  ) {
    currentDocumentAccess = access
    phase = .loaded(document)
    draftContent = document.content
    self.isEditing = isEditing
    saveStatusMessage = nil
    saveErrorMessage = nil
  }

  private func performSave(
    to url: URL,
    expectedModificationDate: Date?,
    expectedContent: String?,
    expectedTargetExists: Bool
  ) {
    guard let currentDocument, !isSaving else { return }

    let contentToSave = draftContent
    let sourceURL = currentDocument.url.standardizedFileURL
    let destinationURL = url.standardizedFileURL
    let destinationAccess =
      destinationURL == sourceURL
      ? currentDocumentAccess ?? SecurityScopedAccess(url: url)
      : SecurityScopedAccess(url: url)
    let operationID = UUID()
    let fileService = self.fileService

    saveTask?.cancel()
    saveOperationID = operationID
    isSaving = true
    saveErrorMessage = nil
    saveStatusMessage = "正在保存…"

    saveTask = Task { [weak self] in
      do {
        let savedDocument = try await Task.detached(priority: .userInitiated) {
          try fileService.saveDocument(
            content: contentToSave,
            to: destinationURL,
            expectedModificationDate: expectedModificationDate,
            expectedContent: expectedContent,
            expectedTargetExists: expectedTargetExists
          )
        }.value
        guard !Task.isCancelled, let self, saveOperationID == operationID else { return }

        let draftAfterSave = draftContent
        let savedURL = savedDocument.url.standardizedFileURL
        let savedAccess =
          savedURL == destinationURL
          ? destinationAccess : SecurityScopedAccess(url: savedDocument.url)
        let savedResourceRootURL =
          savedURL == sourceURL
          ? currentDocument.resourceRootURL
          : containingWorkspaceRoot(for: savedURL)
        let savedWithResourceRoot = savedDocument.withResourceRoot(savedResourceRootURL)
        currentDocumentAccess = savedAccess
        phase = .loaded(savedWithResourceRoot)
        if draftAfterSave == contentToSave {
          draftContent = savedDocument.content
          saveStatusMessage = "已保存"
        } else {
          draftContent = draftAfterSave
          saveStatusMessage = "已保存上一版本，当前仍有未保存的更改"
        }
        isSaving = false
        saveOperationID = nil
        saveTask = nil

        if savedURL != sourceURL {
          recordRecentDocument(savedDocument.url)
        }

        if opensPendingDocumentAfterSave {
          if hasUnsavedChanges {
            opensPendingDocumentAfterSave = false
            isUnsavedChangesConfirmationPresented = true
          } else {
            openPendingDocument()
          }
        }
      } catch {
        guard !Task.isCancelled, let self, saveOperationID == operationID else { return }
        isSaving = false
        saveOperationID = nil
        saveTask = nil
        saveStatusMessage = nil
        saveErrorMessage = error.localizedDescription
        if opensPendingDocumentAfterSave {
          opensPendingDocumentAfterSave = false
          isUnsavedChangesConfirmationPresented = true
        }
      }
    }
  }

  private func snapshotSaveTarget(at url: URL) throws -> SaveTargetSnapshot {
    let hasSecurityScope = url.startAccessingSecurityScopedResource()
    defer {
      if hasSecurityScope {
        url.stopAccessingSecurityScopedResource()
      }
    }

    let fileManager = FileManager.default
    let path = url.path(percentEncoded: false)
    guard fileManager.fileExists(atPath: path) else {
      return SaveTargetSnapshot(exists: false, modificationDate: nil, content: nil)
    }

    let attributes = try fileManager.attributesOfItem(atPath: path)
    guard attributes[.type] as? FileAttributeType == .typeRegular else {
      throw FileAccessError.notRegularFile
    }
    guard let fileSize = attributes[.size] as? NSNumber else {
      throw CocoaError(.fileReadUnknown)
    }
    guard fileSize.intValue <= LocalFileService.defaultMaximumFileSize else {
      throw FileAccessError.fileTooLarge(
        actual: fileSize.intValue,
        limit: LocalFileService.defaultMaximumFileSize
      )
    }

    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let data = try handle.read(upToCount: fileSize.intValue + 1) ?? Data()
    guard data.count == fileSize.intValue else {
      throw FileAccessError.fileModifiedExternally
    }
    guard let content = String(data: data, encoding: .utf8) else {
      throw FileAccessError.invalidUTF8
    }

    let latestAttributes = try fileManager.attributesOfItem(atPath: path)
    guard
      latestAttributes[.type] as? FileAttributeType == .typeRegular,
      (latestAttributes[.size] as? NSNumber)?.intValue == fileSize.intValue,
      latestAttributes[.modificationDate] as? Date
        == attributes[.modificationDate] as? Date
    else {
      throw FileAccessError.fileModifiedExternally
    }

    return SaveTargetSnapshot(
      exists: true,
      modificationDate: attributes[.modificationDate] as? Date,
      content: content
    )
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
          reloadCurrentDocumentIfNeeded(
            in: snapshot.rootURL,
            skipsUnchangedDocument: reason == .automatic
          )
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

  private func reloadCurrentDocumentIfNeeded(
    in rootURL: URL,
    skipsUnchangedDocument: Bool
  ) {
    guard let document = currentDocument else { return }
    guard Self.contains(document.url, in: rootURL) else { return }
    guard !hasUnsavedChanges, !isSaving else { return }
    if skipsUnchangedDocument, documentOnDiskMatchesSnapshot(document) {
      return
    }
    loadDocument(
      at: document.url,
      recordsRecentDocument: false,
      preferredResourceRootURL: rootURL,
      preservesEditingState: true
    )
  }

  private func documentOnDiskMatchesSnapshot(_ document: MarkdownDocument) -> Bool {
    guard
      let attributes = try? FileManager.default.attributesOfItem(
        atPath: document.url.path(percentEncoded: false)
      ),
      attributes[.modificationDate] as? Date == document.modificationDate,
      let fileSize = attributes[.size] as? NSNumber,
      fileSize.intValue == document.byteCount
    else { return false }

    do {
      let handle = try FileHandle(forReadingFrom: document.url)
      defer { try? handle.close() }
      let data = try handle.read(upToCount: document.byteCount + 1) ?? Data()
      return data.count == document.byteCount
        && data.elementsEqual(document.content.utf8)
    } catch {
      return false
    }
  }

  private func canCloseWorkspaceContainingCurrentDocument(_ rootURL: URL) -> Bool {
    guard
      hasUnsavedChanges,
      let document = currentDocument,
      Self.contains(document.url, in: rootURL)
    else { return true }

    saveErrorMessage = "当前文稿有未保存的更改，请先保存或还原后再关闭文件夹。"
    return false
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
        currentDocumentAccess = nil
        phase = .empty
        draftContent = ""
        isEditing = false
        saveStatusMessage = nil
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

      do {
        let directoryURL = FileManager.default.temporaryDirectory
          .appendingPathComponent("FluxReaderUITests", isDirectory: true)
        try FileManager.default.createDirectory(
          at: directoryURL,
          withIntermediateDirectories: true
        )
        let url = directoryURL.appendingPathComponent("FluxReaderUITest.md")
        try Data(content.utf8).write(to: url, options: .atomic)
        applyLoadedDocument(try fileService.loadDocument(at: url), access: nil)
      } catch {
        phase = .failure(error.localizedDescription)
      }
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
