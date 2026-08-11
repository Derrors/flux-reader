import CryptoKit
import Foundation

struct DraftRecoveryRecord: Codable, Equatable, Sendable {
  static let currentFormatVersion = 1

  let formatVersion: Int
  let sourceURL: URL
  let sourceBookmark: Data?
  let baselineModificationDate: Date?
  let baselineByteCount: Int
  let baselineContentDigest: String
  let draftContent: String
  let updatedAt: Date

  init(
    sourceURL: URL,
    sourceBookmark: Data?,
    baselineModificationDate: Date?,
    baselineByteCount: Int,
    baselineContentDigest: String,
    draftContent: String,
    updatedAt: Date = Date()
  ) {
    self.formatVersion = Self.currentFormatVersion
    self.sourceURL = sourceURL.standardizedFileURL
    self.sourceBookmark = sourceBookmark
    self.baselineModificationDate = baselineModificationDate
    self.baselineByteCount = baselineByteCount
    self.baselineContentDigest = baselineContentDigest
    self.draftContent = draftContent
    self.updatedAt = updatedAt
  }

  init(document: MarkdownDocument, draftContent: String, updatedAt: Date = Date()) {
    let bookmark = try? document.url.bookmarkData(
      options: .withSecurityScope,
      includingResourceValuesForKeys: nil,
      relativeTo: nil
    )
    self.init(
      sourceURL: document.url,
      sourceBookmark: bookmark,
      baselineModificationDate: document.modificationDate,
      baselineByteCount: document.byteCount,
      baselineContentDigest: Self.contentDigest(document.content),
      draftContent: draftContent,
      updatedAt: updatedAt
    )
  }

  func withDraftContent(_ content: String, updatedAt: Date = Date()) -> Self {
    Self(
      sourceURL: sourceURL,
      sourceBookmark: sourceBookmark,
      baselineModificationDate: baselineModificationDate,
      baselineByteCount: baselineByteCount,
      baselineContentDigest: baselineContentDigest,
      draftContent: content,
      updatedAt: updatedAt
    )
  }

  func resolvedSourceURL() throws -> URL {
    guard let sourceBookmark else { return sourceURL.standardizedFileURL }
    var isStale = false
    return try URL(
      resolvingBookmarkData: sourceBookmark,
      options: [.withSecurityScope, .withoutUI],
      relativeTo: nil,
      bookmarkDataIsStale: &isStale
    ).standardizedFileURL
  }

  func baselineMatches(_ document: MarkdownDocument) -> Bool {
    document.url.standardizedFileURL == sourceURL.standardizedFileURL
      && document.byteCount == baselineByteCount
      && Self.contentDigest(document.content) == baselineContentDigest
  }

  static func contentDigest(_ content: String) -> String {
    SHA256.hash(data: Data(content.utf8))
      .map { String(format: "%02x", $0) }
      .joined()
  }
}

protocol DraftRecoveryStoring: Sendable {
  func load() throws -> DraftRecoveryRecord?
  func save(_ record: DraftRecoveryRecord) throws
  func clear() throws
}

struct LocalDraftRecoveryStore: DraftRecoveryStoring {
  // JSON may escape control characters, so keep headroom above the 10 MiB
  // editable document limit instead of sizing this record to raw text alone.
  static let maximumRecordSize = 64 * 1_024 * 1_024

  let fileURL: URL

  init(fileURL: URL? = nil) {
    if let fileURL {
      self.fileURL = fileURL.standardizedFileURL
      return
    }

    self.fileURL = Self.defaultFileURL()
  }

  static func defaultFileURL(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> URL {
    #if DEBUG
      if environment["FLUX_READER_UI_TESTING"] == "1" {
        let sanitizedTestID =
          environment["FLUX_READER_UI_TEST_DOCUMENT_ID"]?
          .replacingOccurrences(
            of: "[^A-Za-z0-9_-]",
            with: "-",
            options: .regularExpression
          ) ?? "missing-test-id"
        let testID = sanitizedTestID.isEmpty ? "missing-test-id" : sanitizedTestID
        return FileManager.default.temporaryDirectory
          .appendingPathComponent("FluxReaderUITests", isDirectory: true)
          .appendingPathComponent(testID, isDirectory: true)
          .appendingPathComponent("Recovery", isDirectory: true)
          .appendingPathComponent("active-draft.json", isDirectory: false)
          .standardizedFileURL
      }
    #endif

    let applicationSupportURL =
      FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first
      ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support", isDirectory: true)
    let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.derrors.FluxReader"
    return
      applicationSupportURL
      .appendingPathComponent(bundleIdentifier, isDirectory: true)
      .appendingPathComponent("Recovery", isDirectory: true)
      .appendingPathComponent("active-draft.json", isDirectory: false)
  }

  func load() throws -> DraftRecoveryRecord? {
    let path = fileURL.path(percentEncoded: false)
    guard FileManager.default.fileExists(atPath: path) else { return nil }

    let attributes = try FileManager.default.attributesOfItem(atPath: path)
    guard
      attributes[.type] as? FileAttributeType == .typeRegular,
      let size = attributes[.size] as? NSNumber,
      size.intValue <= Self.maximumRecordSize
    else {
      throw CocoaError(.fileReadCorruptFile)
    }

    let data = try Data(contentsOf: fileURL)
    guard data.count <= Self.maximumRecordSize else {
      throw CocoaError(.fileReadTooLarge)
    }
    let record = try JSONDecoder().decode(DraftRecoveryRecord.self, from: data)
    guard
      record.formatVersion == DraftRecoveryRecord.currentFormatVersion,
      record.sourceURL.isFileURL,
      MarkdownDocument.supports(record.sourceURL),
      record.draftContent.utf8.count <= LocalFileService.defaultMaximumFileSize
    else {
      throw CocoaError(.fileReadCorruptFile)
    }
    return record
  }

  func save(_ record: DraftRecoveryRecord) throws {
    let data = try JSONEncoder().encode(record)
    guard data.count <= Self.maximumRecordSize else {
      throw CocoaError(.fileWriteOutOfSpace)
    }

    let directoryURL = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directoryURL,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try data.write(to: fileURL, options: [.atomic])
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: fileURL.path(percentEncoded: false)
    )
  }

  func clear() throws {
    guard FileManager.default.fileExists(atPath: fileURL.path(percentEncoded: false)) else {
      return
    }
    try FileManager.default.removeItem(at: fileURL)
  }
}

final class DraftRecoveryPersistence: @unchecked Sendable {
  private let store: any DraftRecoveryStoring
  private let lock = NSLock()
  private var generation: UInt64 = 0

  init(store: any DraftRecoveryStoring) {
    self.store = store
  }

  func advanceGeneration() -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    generation &+= 1
    return generation
  }

  func load() throws -> DraftRecoveryRecord? {
    lock.lock()
    defer { lock.unlock() }
    return try store.load()
  }

  func persist(
    document: MarkdownDocument,
    draftContent: String,
    recoveredBaseline: DraftRecoveryRecord?,
    generation expectedGeneration: UInt64
  ) throws {
    lock.lock()
    defer { lock.unlock() }
    guard generation == expectedGeneration else { return }
    let record =
      recoveredBaseline?.withDraftContent(draftContent)
      ?? DraftRecoveryRecord(document: document, draftContent: draftContent)
    try store.save(record)
  }

  func clear(generation expectedGeneration: UInt64) throws {
    lock.lock()
    defer { lock.unlock() }
    guard generation == expectedGeneration else { return }
    try store.clear()
  }
}

struct DocumentSessionTabRecord: Codable, Equatable, Sendable, Identifiable {
  static let currentFormatVersion = 1

  let formatVersion: Int
  let sourceURL: URL
  let sourceBookmark: Data?
  let baselineModificationDate: Date?
  let baselineByteCount: Int
  let baselineContentDigest: String
  let draftContent: String?
  let isEditing: Bool
  let isSplitView: Bool
  let updatedAt: Date

  var id: URL { sourceURL.standardizedFileURL }
  var hasUnsavedChanges: Bool { draftContent != nil }

  init(
    document: MarkdownDocument,
    draftContent: String,
    isEditing: Bool,
    isSplitView: Bool,
    updatedAt: Date = Date()
  ) {
    let bookmark = try? document.url.bookmarkData(
      options: .withSecurityScope,
      includingResourceValuesForKeys: nil,
      relativeTo: nil
    )
    self.formatVersion = Self.currentFormatVersion
    self.sourceURL = document.url.standardizedFileURL
    self.sourceBookmark = bookmark
    self.baselineModificationDate = document.modificationDate
    self.baselineByteCount = document.byteCount
    self.baselineContentDigest = DraftRecoveryRecord.contentDigest(document.content)
    self.draftContent = draftContent == document.content ? nil : draftContent
    self.isEditing = isEditing
    self.isSplitView = isSplitView
    self.updatedAt = updatedAt
  }

  func resolvedSourceURL() throws -> URL {
    guard let sourceBookmark else { return sourceURL.standardizedFileURL }
    var isStale = false
    return try URL(
      resolvingBookmarkData: sourceBookmark,
      options: [.withSecurityScope, .withoutUI],
      relativeTo: nil,
      bookmarkDataIsStale: &isStale
    ).standardizedFileURL
  }

  func baselineMatches(_ document: MarkdownDocument) -> Bool {
    document.byteCount == baselineByteCount
      && DraftRecoveryRecord.contentDigest(document.content) == baselineContentDigest
  }
}

struct DocumentSessionRecord: Codable, Equatable, Sendable {
  static let currentFormatVersion = 1
  static let maximumTabCount = 12

  let formatVersion: Int
  let tabs: [DocumentSessionTabRecord]
  let activeTabURL: URL?
  let updatedAt: Date

  init(
    tabs: [DocumentSessionTabRecord],
    activeTabURL: URL?,
    updatedAt: Date = Date()
  ) {
    self.formatVersion = Self.currentFormatVersion
    self.tabs = Array(tabs.prefix(Self.maximumTabCount))
    let normalizedActiveURL = activeTabURL?.standardizedFileURL
    self.activeTabURL =
      self.tabs.contains(where: { $0.id == normalizedActiveURL })
      ? normalizedActiveURL : self.tabs.first?.id
    self.updatedAt = updatedAt
  }
}

protocol DocumentSessionStoring: Sendable {
  func load() throws -> DocumentSessionRecord?
  func save(_ record: DocumentSessionRecord) throws
  func clear() throws
}

struct LocalDocumentSessionStore: DocumentSessionStoring {
  // A restored session may contain unsaved drafts for all twelve tabs.
  static let maximumRecordSize = 160 * 1_024 * 1_024

  let fileURL: URL

  init(fileURL: URL? = nil) {
    self.fileURL = (fileURL ?? Self.defaultFileURL()).standardizedFileURL
  }

  static func defaultFileURL(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> URL {
    #if DEBUG
      if environment["FLUX_READER_UI_TESTING"] == "1" {
        let rawID = environment["FLUX_READER_UI_TEST_DOCUMENT_ID"] ?? "missing-test-id"
        let testID = rawID.replacingOccurrences(
          of: "[^A-Za-z0-9_-]",
          with: "-",
          options: .regularExpression
        )
        return FileManager.default.temporaryDirectory
          .appendingPathComponent("FluxReaderUITests", isDirectory: true)
          .appendingPathComponent(testID.isEmpty ? "missing-test-id" : testID, isDirectory: true)
          .appendingPathComponent("Sessions", isDirectory: true)
          .appendingPathComponent("document-session.json", isDirectory: false)
      }
    #endif

    let applicationSupportURL =
      FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support", isDirectory: true)
    let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.derrors.FluxReader"
    return
      applicationSupportURL
      .appendingPathComponent(bundleIdentifier, isDirectory: true)
      .appendingPathComponent("Sessions", isDirectory: true)
      .appendingPathComponent("document-session.json", isDirectory: false)
  }

  func load() throws -> DocumentSessionRecord? {
    let path = fileURL.path(percentEncoded: false)
    guard FileManager.default.fileExists(atPath: path) else { return nil }
    let attributes = try FileManager.default.attributesOfItem(atPath: path)
    guard
      attributes[.type] as? FileAttributeType == .typeRegular,
      let size = attributes[.size] as? NSNumber,
      size.intValue <= Self.maximumRecordSize
    else { throw CocoaError(.fileReadCorruptFile) }

    let data = try Data(contentsOf: fileURL, options: [.mappedIfSafe])
    guard data.count <= Self.maximumRecordSize else { throw CocoaError(.fileReadTooLarge) }
    let record = try JSONDecoder().decode(DocumentSessionRecord.self, from: data)
    guard
      record.formatVersion == DocumentSessionRecord.currentFormatVersion,
      record.tabs.count <= DocumentSessionRecord.maximumTabCount,
      record.tabs.allSatisfy({ tab in
        tab.formatVersion == DocumentSessionTabRecord.currentFormatVersion
          && tab.sourceURL.isFileURL
          && MarkdownDocument.supports(tab.sourceURL)
          && tab.baselineByteCount >= 0
          && tab.draftContent.map {
            $0.utf8.count <= LocalFileService.defaultMaximumFileSize
          } ?? true
      })
    else { throw CocoaError(.fileReadCorruptFile) }
    return record
  }

  func save(_ record: DocumentSessionRecord) throws {
    let data = try JSONEncoder().encode(record)
    guard data.count <= Self.maximumRecordSize else { throw CocoaError(.fileWriteOutOfSpace) }
    let directoryURL = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directoryURL,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try data.write(to: fileURL, options: [.atomic])
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: fileURL.path(percentEncoded: false)
    )
  }

  func clear() throws {
    guard FileManager.default.fileExists(atPath: fileURL.path(percentEncoded: false)) else {
      return
    }
    try FileManager.default.removeItem(at: fileURL)
  }
}

final class DocumentSessionPersistence: @unchecked Sendable {
  private let store: any DocumentSessionStoring
  private let lock = NSLock()
  private var generation: UInt64 = 0

  init(store: any DocumentSessionStoring) {
    self.store = store
  }

  func load() throws -> DocumentSessionRecord? {
    lock.lock()
    defer { lock.unlock() }
    return try store.load()
  }

  func advanceGeneration() -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    generation &+= 1
    return generation
  }

  func save(_ record: DocumentSessionRecord, generation expectedGeneration: UInt64) throws {
    lock.lock()
    defer { lock.unlock() }
    guard generation == expectedGeneration else { return }
    try store.save(record)
  }

  func clear(generation expectedGeneration: UInt64) throws {
    lock.lock()
    defer { lock.unlock() }
    guard generation == expectedGeneration else { return }
    try store.clear()
  }
}
