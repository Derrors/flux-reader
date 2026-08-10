import Combine
import Darwin
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

  struct SaveAsPresentation: Equatable {
    let sourceDocumentURL: URL
    let suggestedDirectoryURL: URL
    let suggestedFileName: String
  }

  private struct PendingDocumentOpen {
    let url: URL
    let recordsRecentDocument: Bool
    let preferredResourceRootURL: URL?
    let preservesEditingState: Bool
    let retainedRecoveryVersionID: UUID?
  }

  private struct SaveTargetSnapshot: Sendable {
    let exists: Bool
    let modificationDate: Date?
    let content: String?
  }

  private enum DraftRecoveryOperationKind: Equatable {
    case persist
    case clear
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
      scheduleDraftRecoveryPersistence()
    }
  }
  @Published private(set) var isEditing = false
  @Published private(set) var isSaving = false
  @Published private(set) var saveStatusMessage: String?
  @Published private(set) var saveErrorMessage: String?
  @Published private(set) var draftRecoveryMessage: String?
  @Published private(set) var isDraftRecoverySyncing = false
  @Published private(set) var draftRecoveryCleanupErrorMessage: String?
  @Published private(set) var retainedRecoveryVersions: [RetainedFileRecoveryVersion] = []
  @Published private(set) var currentRetainedRecoveryVersionID: UUID?
  @Published var recoveryVersionPendingDeletion: RetainedFileRecoveryVersion?
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
  private let draftRecoveryPersistence: DraftRecoveryPersistence
  private let retainedRecoveryStore: any RetainedFileRecoveryStoring
  private var loadTask: Task<Void, Never>?
  private var documentLoadGeneration: UInt64 = 0
  private var activeDocumentLoad: PendingDocumentOpen?
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
  private var documentSessionID = UUID()
  private var pendingDocumentOpen: PendingDocumentOpen?
  private var opensPendingDocumentAfterSave = false
  private var didRestoreLibrary = false
  private var draftRecoveryTask: Task<Void, Never>?
  private var draftRecoveryOperationID: UUID?
  private var draftRestoreOperationID: UUID?
  private var isDraftRestorePending = false
  private var deferredDocumentLoadDuringDraftRestore: PendingDocumentOpen?
  private var recoveredDraftBaseline: DraftRecoveryRecord?
  private var isApplyingDocumentState = false
  private var retainedRecoverySourceURLsByID: [UUID: URL] = [:]

  init(
    fileService: (any FileAccessing)? = nil,
    folderService: any FolderIndexing = LocalFolderIndexService(),
    bookmarkStore: any BookmarkStoring = SecurityScopedBookmarkStore(),
    workspaceWatcher: any WorkspaceWatching = FSEventWorkspaceWatcher(),
    searchService: any WorkspaceSearching = LocalWorkspaceSearchService(),
    draftRecoveryStore: any DraftRecoveryStoring = LocalDraftRecoveryStore(),
    retainedRecoveryStore: any RetainedFileRecoveryStoring =
      LocalRetainedFileRecoveryStore()
  ) {
    self.fileService =
      fileService ?? LocalFileService(retainedRecoveryStore: retainedRecoveryStore)
    self.folderService = folderService
    self.bookmarkStore = bookmarkStore
    self.workspaceWatcher = workspaceWatcher
    self.searchService = searchService
    self.draftRecoveryPersistence = DraftRecoveryPersistence(store: draftRecoveryStore)
    self.retainedRecoveryStore = retainedRecoveryStore
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

  var isViewingRetainedRecoveryVersion: Bool {
    currentDocument != nil && currentRetainedRecoveryVersionID != nil
  }

  var canEdit: Bool {
    currentDocument != nil && !isViewingRetainedRecoveryVersion
  }

  var canSave: Bool {
    currentDocument != nil && hasUnsavedChanges && !isSaving
      && !isViewingRetainedRecoveryVersion
  }

  var canSaveAs: Bool {
    currentDocument != nil && !isSaving
  }

  var saveAsPresentation: SaveAsPresentation? {
    guard let document = currentDocument else { return nil }
    let suggestedURL: URL
    if let versionID = currentRetainedRecoveryVersionID {
      suggestedURL =
        retainedRecoverySourceURLsByID[versionID]
        ?? retainedRecoveryVersions.first(where: { $0.id == versionID }).flatMap {
          (try? $0.resolvedSourceURL()) ?? $0.sourceURL.standardizedFileURL
        }
        ?? document.url.standardizedFileURL
    } else {
      suggestedURL = document.url.standardizedFileURL
    }
    return SaveAsPresentation(
      sourceDocumentURL: document.url.standardizedFileURL,
      suggestedDirectoryURL: suggestedURL.deletingLastPathComponent(),
      suggestedFileName: suggestedURL.lastPathComponent
    )
  }

  var hasDraftRecoveryCleanupFailure: Bool {
    draftRecoveryCleanupErrorMessage != nil
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
      let uiTestDocumentURL = prepareUITestDocumentIfPresent()
    #endif

    refreshRecentDocuments()
    refreshRetainedRecoveryVersions()
    restoreDraftIfPresent()

    #if DEBUG
      if let uiTestDocumentURL {
        loadDocument(
          at: uiTestDocumentURL,
          recordsRecentDocument: false
        )
        return
      }
    #endif

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
    guard canEdit else { return }
    isEditing.toggle()
  }

  func save() {
    guard
      let document = currentDocument,
      hasUnsavedChanges,
      !isViewingRetainedRecoveryVersion
    else { return }
    launchSave(
      to: document.url,
      sourceDocument: document,
      contentToSave: draftContent,
      resolveTargetSnapshot: {
        SaveTargetSnapshot(
          exists: true,
          modificationDate: document.modificationDate,
          content: document.content
        )
      }
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
    guard !isSaving else { return }
    let destinationURL = url.standardizedFileURL
    if isViewingRetainedRecoveryVersion,
      Self.fileURLsReferToSameLocation(destinationURL, document.url)
    {
      saveErrorMessage = "恢复版本是只读安全副本，不能覆盖；请选择原文稿或其他位置。"
      return
    }
    let snapshotResolver: @Sendable () throws -> SaveTargetSnapshot
    if destinationURL == document.url.standardizedFileURL {
      let snapshot = SaveTargetSnapshot(
        exists: true,
        modificationDate: document.modificationDate,
        content: document.content
      )
      snapshotResolver = { @Sendable in snapshot }
    } else {
      snapshotResolver = { @Sendable in
        try Self.snapshotSaveTarget(at: destinationURL)
      }
    }
    launchSave(
      to: url,
      sourceDocument: document,
      contentToSave: draftContent,
      resolveTargetSnapshot: snapshotResolver
    )
  }

  func revertDraft() {
    guard let document = currentDocument else { return }
    draftContent = document.content
    saveStatusMessage = nil
    clearDraftRecoveryNow()
  }

  func reloadFromDisk() {
    guard let document = currentDocument else { return }
    requestDocumentOpen(
      at: document.url,
      recordsRecentDocument: false,
      preferredResourceRootURL: document.resourceRootURL,
      allowsReloadingCurrentDocument: true,
      preservesEditingState: true,
      retainedRecoveryVersionID: currentRetainedRecoveryVersionID
    )
  }

  func dismissSaveError() {
    saveErrorMessage = nil
  }

  func dismissDraftRecoveryMessage() {
    draftRecoveryMessage = nil
  }

  func openRetainedRecoveryVersion(_ version: RetainedFileRecoveryVersion) {
    Task { [weak self] in
      do {
        let urls = try await Task.detached(priority: .userInitiated) {
          let recoveryURL = try version.resolvedRecoveryURL()
          let sourceURL =
            (try? version.resolvedSourceURL()) ?? version.sourceURL.standardizedFileURL
          return (recoveryURL, sourceURL)
        }.value
        self?.retainedRecoverySourceURLsByID[version.id] = urls.1
        self?.requestDocumentOpen(
          at: urls.0,
          recordsRecentDocument: false,
          preferredResourceRootURL: nil,
          retainedRecoveryVersionID: version.id
        )
      } catch {
        self?.saveErrorMessage = error.localizedDescription
      }
    }
  }

  func requestDeleteRetainedRecoveryVersion(_ version: RetainedFileRecoveryVersion) {
    recoveryVersionPendingDeletion = version
  }

  func cancelDeleteRetainedRecoveryVersion() {
    recoveryVersionPendingDeletion = nil
  }

  func confirmDeleteRetainedRecoveryVersion() {
    guard let version = recoveryVersionPendingDeletion else { return }
    recoveryVersionPendingDeletion = nil
    let store = retainedRecoveryStore
    Task { [weak self] in
      let errorMessage = await Task.detached(priority: .utility) {
        do {
          try store.deleteVersion(version.id, now: Date())
          return nil as String?
        } catch {
          return error.localizedDescription
        }
      }.value
      guard let self else { return }
      if let errorMessage {
        saveErrorMessage = errorMessage
      }
      refreshRetainedRecoveryVersions()
    }
  }

  @discardableResult
  func discardChangesForTermination() -> Bool {
    clearDraftRecoveryNow()
  }

  func retryDraftRecoveryCleanup() {
    guard !hasUnsavedChanges, !isSaving else { return }
    scheduleDraftRecoveryClear()
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
    guard clearDraftRecoveryNow() else { return }
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
    if let document = currentDocument,
      workspaces.contains(where: { Self.contains(document.url, in: $0.rootURL) })
    {
      if isSaving {
        saveErrorMessage = "当前文稿正在保存，请等待保存完成后再关闭文件夹。"
        return
      }
      if hasUnsavedChanges {
        saveErrorMessage = "当前文稿有未保存的更改，请先保存或还原后再关闭文件夹。"
        return
      }
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
    preservesEditingState: Bool = false,
    retainedRecoveryVersionID: UUID? = nil
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
      preservesEditingState: preservesEditingState,
      retainedRecoveryVersionID: retainedRecoveryVersionID
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
        preservesEditingState: preservesEditingState,
        retainedRecoveryVersionID: retainedRecoveryVersionID
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
      preservesEditingState: request.preservesEditingState,
      retainedRecoveryVersionID: request.retainedRecoveryVersionID
    )
  }

  private func loadDocument(
    at url: URL,
    recordsRecentDocument: Bool,
    preferredResourceRootURL: URL? = nil,
    preservesEditingState: Bool = false,
    retainedRecoveryVersionID: UUID? = nil
  ) {
    guard MarkdownDocument.supports(url) else {
      phase = .failure(
        FileAccessError.unsupportedFileType(url.pathExtension).localizedDescription
      )
      return
    }

    if isDraftRestorePending {
      deferredDocumentLoadDuringDraftRestore = PendingDocumentOpen(
        url: url,
        recordsRecentDocument: recordsRecentDocument,
        preferredResourceRootURL: preferredResourceRootURL,
        preservesEditingState: preservesEditingState,
        retainedRecoveryVersionID: retainedRecoveryVersionID
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
    documentLoadGeneration &+= 1
    let loadGeneration = documentLoadGeneration
    activeDocumentLoad = PendingDocumentOpen(
      url: url,
      recordsRecentDocument: recordsRecentDocument,
      preferredResourceRootURL: preferredResourceRootURL,
      preservesEditingState: preservesEditingState,
      retainedRecoveryVersionID: retainedRecoveryVersionID
    )
    phase = .loading(url.lastPathComponent)

    let resourceRootURL = preferredResourceRootURL ?? containingWorkspaceRoot(for: candidateURL)
    let editingState = preservesEditingState && isEditing && retainedRecoveryVersionID == nil
    let fileService = self.fileService
    loadTask = Task { [weak self] in
      do {
        let document = try await Task.detached(priority: .userInitiated) {
          try fileService.loadDocument(at: candidateURL)
        }.value
        guard
          !Task.isCancelled,
          let self,
          self.documentLoadGeneration == loadGeneration
        else { return }
        self.activeDocumentLoad = nil
        applyLoadedDocument(
          document.withResourceRoot(resourceRootURL),
          access: candidateAccess,
          isEditing: editingState,
          retainedRecoveryVersionID: retainedRecoveryVersionID
        )
      } catch {
        guard
          !Task.isCancelled,
          self?.documentLoadGeneration == loadGeneration
        else { return }
        self?.activeDocumentLoad = nil
        self?.phase = .failure(error.localizedDescription)
      }
    }
  }

  private func applyLoadedDocument(
    _ document: MarkdownDocument,
    access: SecurityScopedAccess?,
    isEditing: Bool = false,
    retainedRecoveryVersionID: UUID? = nil
  ) {
    isApplyingDocumentState = true
    defer { isApplyingDocumentState = false }
    documentSessionID = UUID()
    recoveredDraftBaseline = nil
    currentRetainedRecoveryVersionID = retainedRecoveryVersionID
    currentDocumentAccess = access
    phase = .loaded(document)
    draftContent = document.content
    self.isEditing = isEditing && retainedRecoveryVersionID == nil
    saveStatusMessage = nil
    saveErrorMessage = nil
  }

  private func scheduleDraftRecoveryPersistence() {
    guard !isApplyingDocumentState else { return }
    draftRecoveryTask?.cancel()

    let generation = draftRecoveryPersistence.advanceGeneration()
    guard let document = currentDocument, draftContent != document.content else {
      scheduleDraftRecoveryClear(generation: generation)
      return
    }

    let draft = draftContent
    let recoveredBaseline = recoveredDraftBaseline
    let persistence = draftRecoveryPersistence
    let operationID = beginDraftRecoveryOperation()
    draftRecoveryTask = Task { [weak self] in
      do {
        try await Task.sleep(for: .milliseconds(500))
        try Task.checkCancellation()
        let errorMessage = await Task.detached(priority: .utility) {
          do {
            try persistence.persist(
              document: document,
              draftContent: draft,
              recoveredBaseline: recoveredBaseline,
              generation: generation
            )
            return nil as String?
          } catch {
            return error.localizedDescription
          }
        }.value
        guard let self else { return }
        finishDraftRecoveryOperation(
          operationID: operationID,
          kind: .persist,
          errorMessage: errorMessage
        )
      } catch is CancellationError {
        return
      } catch {
        guard let self else { return }
        finishDraftRecoveryOperation(
          operationID: operationID,
          kind: .persist,
          errorMessage: error.localizedDescription
        )
      }
    }
  }

  private func scheduleDraftRecoveryClear(generation: UInt64? = nil) {
    draftRecoveryTask?.cancel()
    let expectedGeneration = generation ?? draftRecoveryPersistence.advanceGeneration()
    let operationID = beginDraftRecoveryOperation()
    let persistence = draftRecoveryPersistence
    draftRecoveryTask = Task { [weak self] in
      let errorMessage = await Task.detached(priority: .utility) {
        do {
          try persistence.clear(generation: expectedGeneration)
          return nil as String?
        } catch {
          return error.localizedDescription
        }
      }.value
      guard let self else { return }
      finishDraftRecoveryOperation(
        operationID: operationID,
        kind: .clear,
        errorMessage: errorMessage
      )
    }
  }

  private func beginDraftRecoveryOperation() -> UUID {
    let operationID = UUID()
    draftRecoveryOperationID = operationID
    isDraftRecoverySyncing = true
    return operationID
  }

  private func finishDraftRecoveryOperation(
    operationID: UUID,
    kind: DraftRecoveryOperationKind,
    errorMessage: String?
  ) {
    guard draftRecoveryOperationID == operationID else { return }
    draftRecoveryOperationID = nil
    draftRecoveryTask = nil
    isDraftRecoverySyncing = false

    if let errorMessage {
      switch kind {
      case .persist:
        draftRecoveryMessage =
          "无法更新崩溃恢复草稿；当前编辑内容仍在窗口中：\(errorMessage)"
      case .clear:
        recordDraftRecoveryCleanupFailure(errorMessage)
      }
    } else if kind == .clear {
      clearDraftRecoveryCleanupFailure()
    }
  }

  @discardableResult
  private func clearDraftRecoveryNow() -> Bool {
    draftRecoveryTask?.cancel()
    draftRecoveryTask = nil
    draftRecoveryOperationID = nil
    isDraftRecoverySyncing = false
    recoveredDraftBaseline = nil
    let generation = draftRecoveryPersistence.advanceGeneration()
    do {
      try draftRecoveryPersistence.clear(generation: generation)
      clearDraftRecoveryCleanupFailure()
      return true
    } catch {
      recordDraftRecoveryCleanupFailure(error.localizedDescription)
      return false
    }
  }

  private func clearDraftRecoveryBeforeCompletingSave() async -> Bool {
    draftRecoveryTask?.cancel()
    draftRecoveryTask = nil
    recoveredDraftBaseline = nil
    let generation = draftRecoveryPersistence.advanceGeneration()
    let operationID = beginDraftRecoveryOperation()
    let persistence = draftRecoveryPersistence
    let errorMessage = await Task.detached(priority: .utility) {
      do {
        try persistence.clear(generation: generation)
        return nil as String?
      } catch {
        return error.localizedDescription
      }
    }.value
    guard draftRecoveryOperationID == operationID else {
      return errorMessage == nil
    }
    finishDraftRecoveryOperation(
      operationID: operationID,
      kind: .clear,
      errorMessage: errorMessage
    )
    return errorMessage == nil
  }

  private func recordDraftRecoveryCleanupFailure(_ detail: String) {
    let message =
      "无法清理崩溃恢复草稿，恢复记录已保留。请重试，或在退出时明确选择保留：\(detail)"
    draftRecoveryCleanupErrorMessage = message
    draftRecoveryMessage = message
  }

  private func clearDraftRecoveryCleanupFailure() {
    if draftRecoveryMessage == draftRecoveryCleanupErrorMessage {
      draftRecoveryMessage = nil
    }
    draftRecoveryCleanupErrorMessage = nil
  }

  private func restoreDraftIfPresent() {
    let operationID = UUID()
    draftRestoreOperationID = operationID
    isDraftRestorePending = true
    if deferredDocumentLoadDuringDraftRestore == nil {
      deferredDocumentLoadDuringDraftRestore = activeDocumentLoad
    }
    activeDocumentLoad = nil
    documentLoadGeneration &+= 1
    loadTask?.cancel()

    let persistence = draftRecoveryPersistence
    let fileService = self.fileService
    Task { [weak self] in
      do {
        let loadedRecord = try await Task.detached(priority: .utility) {
          try persistence.load()
        }.value
        guard let self, self.draftRestoreOperationID == operationID else { return }
        guard let recovered = loadedRecord else {
          finishDraftRestore(operationID: operationID, recoveredURL: nil)
          return
        }

        let restored = try await Task.detached(priority: .userInitiated) {
          let resolvedURL = try recovered.resolvedSourceURL()
          let access = SecurityScopedAccess(url: resolvedURL)
          let document = try fileService.loadDocument(at: access.url)
          return (document, resolvedURL, recovered.baselineMatches(document))
        }.value
        guard self.draftRestoreOperationID == operationID else { return }

        if let currentDocument,
          currentDocument.url.standardizedFileURL
            != restored.0.url.standardizedFileURL
        {
          draftRecoveryMessage =
            "检测到 \(recovered.sourceURL.lastPathComponent) 的恢复草稿；当前已打开其他文稿，草稿仍安全保留。"
          finishDraftRestore(operationID: operationID, recoveredURL: nil)
          return
        }
        applyRecoveredDraft(
          recovered,
          document: restored.0,
          access: SecurityScopedAccess(url: restored.1),
          baselineMatches: restored.2
        )
        finishDraftRestore(
          operationID: operationID,
          recoveredURL: restored.0.url
        )
      } catch {
        guard let self, self.draftRestoreOperationID == operationID else { return }
        draftRecoveryMessage =
          "检测到未保存草稿，但暂时无法重新打开源文件。草稿仍保存在恢复目录中：\(error.localizedDescription)"
        finishDraftRestore(operationID: operationID, recoveredURL: nil)
      }
    }
  }

  private func finishDraftRestore(
    operationID: UUID,
    recoveredURL: URL?
  ) {
    guard draftRestoreOperationID == operationID else { return }
    draftRestoreOperationID = nil
    isDraftRestorePending = false

    guard let request = deferredDocumentLoadDuringDraftRestore else { return }
    deferredDocumentLoadDuringDraftRestore = nil
    if recoveredURL?.standardizedFileURL == request.url.standardizedFileURL {
      return
    }
    requestDocumentOpen(
      at: request.url,
      recordsRecentDocument: request.recordsRecentDocument,
      preferredResourceRootURL: request.preferredResourceRootURL,
      preservesEditingState: request.preservesEditingState,
      retainedRecoveryVersionID: request.retainedRecoveryVersionID
    )
  }

  private func applyRecoveredDraft(
    _ record: DraftRecoveryRecord,
    document: MarkdownDocument,
    access: SecurityScopedAccess,
    baselineMatches: Bool
  ) {
    documentLoadGeneration &+= 1
    loadTask?.cancel()
    guard record.draftContent != document.content else {
      applyLoadedDocument(document, access: access)
      clearDraftRecoveryNow()
      return
    }

    isApplyingDocumentState = true
    documentSessionID = UUID()
    recoveredDraftBaseline = record
    currentRetainedRecoveryVersionID = nil
    currentDocumentAccess = access
    phase = .loaded(document)
    draftContent = record.draftContent
    isEditing = true
    saveStatusMessage = nil
    saveErrorMessage = nil
    isApplyingDocumentState = false

    draftRecoveryMessage =
      baselineMatches
      ? "已恢复上次退出前未保存的草稿；磁盘文件尚未被覆盖。"
      : "已恢复未保存的草稿，但磁盘版本在此期间发生了变化。恢复内容尚未写入磁盘，请比较后保存或另存为。"
  }

  private func launchSave(
    to url: URL,
    sourceDocument: MarkdownDocument,
    contentToSave: String,
    resolveTargetSnapshot: @escaping @Sendable () throws -> SaveTargetSnapshot
  ) {
    guard !isSaving else { return }

    let sourceURL = sourceDocument.url.standardizedFileURL
    let destinationURL = url.standardizedFileURL
    let destinationAccess =
      destinationURL == sourceURL
      ? currentDocumentAccess ?? SecurityScopedAccess(url: url)
      : SecurityScopedAccess(url: url)
    let operationID = UUID()
    let sourceSessionID = documentSessionID
    let fileService = self.fileService

    saveTask?.cancel()
    saveOperationID = operationID
    isSaving = true
    saveErrorMessage = nil
    saveStatusMessage = "正在准备保存…"

    saveTask = Task { [weak self] in
      do {
        let snapshot = try await Task.detached(priority: .userInitiated) {
          try resolveTargetSnapshot()
        }.value
        guard !Task.isCancelled, let self, self.saveOperationID == operationID else {
          return
        }
        guard
          self.documentSessionID == sourceSessionID,
          self.currentDocument?.url.standardizedFileURL == sourceURL
        else {
          self.finishOrphanedSaveOperation(operationID: operationID)
          return
        }
        self.saveStatusMessage = "正在保存…"

        let savedDocument = try await Task.detached(priority: .userInitiated) {
          try fileService.saveDocument(
            content: contentToSave,
            to: destinationURL,
            expectedModificationDate: snapshot.modificationDate,
            expectedContent: snapshot.content,
            expectedTargetExists: snapshot.exists
          )
        }.value
        guard !Task.isCancelled, self.saveOperationID == operationID else { return }
        guard
          self.documentSessionID == sourceSessionID,
          self.currentDocument?.url.standardizedFileURL == sourceURL
        else {
          self.finishOrphanedSaveOperation(operationID: operationID)
          return
        }

        let draftAfterSave = self.draftContent
        let savedURL = savedDocument.url.standardizedFileURL
        let savedAccess =
          savedURL == destinationURL
          ? destinationAccess : SecurityScopedAccess(url: savedDocument.url)
        let savedResourceRootURL =
          savedURL == sourceURL
          ? sourceDocument.resourceRootURL
          : self.containingWorkspaceRoot(for: savedURL)
        let savedWithResourceRoot = savedDocument.withResourceRoot(savedResourceRootURL)
        self.documentSessionID = UUID()
        self.recoveredDraftBaseline = nil
        self.currentRetainedRecoveryVersionID = nil
        self.currentDocumentAccess = savedAccess
        self.phase = .loaded(savedWithResourceRoot)
        if draftAfterSave == contentToSave {
          self.draftContent = savedDocument.content
          self.saveStatusMessage = "已保存"
        } else {
          self.draftContent = draftAfterSave
          self.saveStatusMessage = "已保存上一版本，当前仍有未保存的更改"
        }

        if draftAfterSave == contentToSave {
          let recoveryWasCleared = await self.clearDraftRecoveryBeforeCompletingSave()
          if !recoveryWasCleared {
            self.saveStatusMessage = "文稿已保存，但恢复草稿未能清理"
          }
        }
        self.isSaving = false
        self.saveOperationID = nil
        self.saveTask = nil
        self.refreshRetainedRecoveryVersions()

        if savedURL != sourceURL {
          self.recordRecentDocument(savedDocument.url)
        }

        if self.opensPendingDocumentAfterSave {
          if self.hasUnsavedChanges {
            self.opensPendingDocumentAfterSave = false
            self.isUnsavedChangesConfirmationPresented = true
          } else {
            self.openPendingDocument()
          }
        }
      } catch {
        guard !Task.isCancelled, let self, saveOperationID == operationID else { return }
        isSaving = false
        saveOperationID = nil
        saveTask = nil
        saveStatusMessage = nil
        saveErrorMessage = error.localizedDescription
        refreshRetainedRecoveryVersions()
        if opensPendingDocumentAfterSave {
          opensPendingDocumentAfterSave = false
          isUnsavedChangesConfirmationPresented = true
        }
      }
    }
  }

  private func finishOrphanedSaveOperation(operationID: UUID) {
    guard saveOperationID == operationID else { return }
    isSaving = false
    saveOperationID = nil
    saveTask = nil
    saveStatusMessage = nil
    saveErrorMessage = "保存上下文已经改变，未更新当前窗口中的文稿状态。"
  }

  private nonisolated static func snapshotSaveTarget(
    at url: URL
  ) throws -> SaveTargetSnapshot {
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

  private nonisolated static func fileURLsReferToSameLocation(
    _ lhs: URL,
    _ rhs: URL
  ) -> Bool {
    guard lhs.isFileURL, rhs.isFileURL else {
      return lhs.standardized == rhs.standardized
    }

    let canonicalLHS = lhs.standardizedFileURL.resolvingSymlinksInPath()
      .standardizedFileURL
    let canonicalRHS = rhs.standardizedFileURL.resolvingSymlinksInPath()
      .standardizedFileURL
    if canonicalLHS == canonicalRHS { return true }

    guard
      let lhsIdentity = fileIdentity(at: canonicalLHS),
      let rhsIdentity = fileIdentity(at: canonicalRHS)
    else { return false }
    return lhsIdentity.device == rhsIdentity.device
      && lhsIdentity.inode == rhsIdentity.inode
  }

  private nonisolated static func fileIdentity(
    at url: URL
  ) -> (device: dev_t, inode: ino_t)? {
    var metadata = stat()
    let result: Int32 = url.withUnsafeFileSystemRepresentation { path in
      guard let path else { return -1 }
      return lstat(path, &metadata)
    }
    guard result == 0 else { return nil }
    return (metadata.st_dev, metadata.st_ino)
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
          await reloadCurrentDocumentIfNeeded(
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
  ) async {
    guard let document = currentDocument else { return }
    guard Self.contains(document.url, in: rootURL) else { return }
    guard !hasUnsavedChanges, !isSaving else { return }
    if skipsUnchangedDocument {
      let matches = await Task.detached(priority: .utility) {
        Self.documentOnDiskMatchesSnapshot(document)
      }.value
      guard
        currentDocument?.url.standardizedFileURL == document.url.standardizedFileURL,
        currentDocument?.content == document.content,
        !hasUnsavedChanges,
        !isSaving
      else { return }
      if matches { return }
    }
    loadDocument(
      at: document.url,
      recordsRecentDocument: false,
      preferredResourceRootURL: rootURL,
      preservesEditingState: true,
      retainedRecoveryVersionID: currentRetainedRecoveryVersionID
    )
  }

  private nonisolated static func documentOnDiskMatchesSnapshot(
    _ document: MarkdownDocument
  ) -> Bool {
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
      let document = currentDocument,
      Self.contains(document.url, in: rootURL)
    else { return true }

    if isSaving {
      saveErrorMessage = "当前文稿正在保存，请等待保存完成后再关闭文件夹。"
      return false
    }
    guard hasUnsavedChanges else { return true }

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
        documentSessionID = UUID()
        currentDocumentAccess = nil
        isApplyingDocumentState = true
        phase = .empty
        draftContent = ""
        isApplyingDocumentState = false
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

  private func refreshRetainedRecoveryVersions() {
    let store = retainedRecoveryStore
    Task { [weak self] in
      let result = await Task.detached(priority: .utility) {
        Result { try store.loadVersions() }
      }.value
      guard let self else { return }
      switch result {
      case .success(let versions):
        retainedRecoveryVersions = versions
      case .failure(let error):
        saveErrorMessage = "无法读取保存恢复版本：\(error.localizedDescription)"
      }
    }
  }

  private static func contains(_ candidateURL: URL, in rootURL: URL) -> Bool {
    let rootPath = rootURL.standardizedFileURL.path(percentEncoded: false)
    let candidatePath = candidateURL.standardizedFileURL.path(percentEncoded: false)
    let boundary = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
    return candidatePath.hasPrefix(boundary)
  }

  #if DEBUG
    private func prepareUITestDocumentIfPresent() -> URL? {
      let environment = ProcessInfo.processInfo.environment
      guard environment["FLUX_READER_UI_TESTING"] == "1" else { return nil }

      do {
        if environment["FLUX_READER_UI_TEST_CLEAR_RECOVERY"] == "1" {
          clearDraftRecoveryNow()
          try (retainedRecoveryStore as? LocalRetainedFileRecoveryStore)?
            .resetForUITesting()
        }
        guard environment["FLUX_READER_UI_TEST_DOCUMENT_ENABLED"] == "1" else {
          return nil
        }
        let sanitizedDocumentID =
          environment["FLUX_READER_UI_TEST_DOCUMENT_ID"]?
          .replacingOccurrences(
            of: "[^A-Za-z0-9_-]",
            with: "-",
            options: .regularExpression
          ) ?? "default"
        let documentID = sanitizedDocumentID.isEmpty ? "default" : sanitizedDocumentID
        let directoryURL = FileManager.default.temporaryDirectory
          .appendingPathComponent("FluxReaderUITests", isDirectory: true)
          .appendingPathComponent(documentID, isDirectory: true)
        try FileManager.default.createDirectory(
          at: directoryURL,
          withIntermediateDirectories: true
        )
        let url = directoryURL.appendingPathComponent("FluxReaderUITest.md")

        if let content = environment["FLUX_READER_UI_TEST_MARKDOWN"],
          environment["FLUX_READER_UI_TEST_RESET_DOCUMENT"] == "1"
            || !FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
        {
          try Data(content.utf8).write(to: url, options: .atomic)
        }
        if let externalContent = environment["FLUX_READER_UI_TEST_EXTERNAL_MARKDOWN"] {
          try Data(externalContent.utf8).write(to: url, options: .atomic)
        }
        if let secondContent = environment["FLUX_READER_UI_TEST_SECOND_MARKDOWN"] {
          let secondURL = directoryURL.appendingPathComponent("Second.md")
          try Data(secondContent.utf8).write(to: secondURL, options: .atomic)
          loadWorkspace(at: directoryURL, reason: .restore)
        }
        return url
      } catch {
        phase = .failure(error.localizedDescription)
        return nil
      }
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
