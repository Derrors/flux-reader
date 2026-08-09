import Foundation

protocol BookmarkStoring: AnyObject {
  func saveWorkspace(_ url: URL) throws
  func restoreWorkspaces() -> [URL]
  func removeWorkspace(_ url: URL)
  func clearWorkspaces()

  func recordRecentDocument(_ url: URL) throws
  func restoreRecentDocuments() -> [RecentDocument]
  func removeRecentDocument(_ url: URL)
  func clearRecentDocuments()
}

struct BookmarkResolution: Sendable {
  let url: URL
  let isStale: Bool
}

struct SecurityScopedBookmarkCodec: Sendable {
  let create: @Sendable (URL) throws -> Data
  let resolve: @Sendable (Data) throws -> BookmarkResolution

  static let live = SecurityScopedBookmarkCodec(
    create: { url in
      try url.bookmarkData(
        options: .withSecurityScope,
        includingResourceValuesForKeys: nil,
        relativeTo: nil
      )
    },
    resolve: { data in
      var isStale = false
      let url = try URL(
        resolvingBookmarkData: data,
        options: [.withSecurityScope, .withoutUI],
        relativeTo: nil,
        bookmarkDataIsStale: &isStale
      )
      return BookmarkResolution(url: url, isStale: isStale)
    }
  )
}

final class SecurityScopedBookmarkStore: BookmarkStoring {
  private struct Record: Codable {
    var bookmarkData: Data
    var path: String
    var displayName: String
    var lastOpenedAt: Date
  }

  private let defaults: UserDefaults
  private let legacyWorkspaceKey: String
  private let workspacesKey: String
  private let recentsKey: String
  private let maximumWorkspaceCount: Int
  private let maximumRecentCount: Int
  private let codec: SecurityScopedBookmarkCodec
  private let encoder = PropertyListEncoder()
  private let decoder = PropertyListDecoder()

  init(
    defaults: UserDefaults = .standard,
    namespace: String = "com.derrors.fluxreader.library",
    maximumWorkspaceCount: Int = 8,
    maximumRecentCount: Int = 12,
    codec: SecurityScopedBookmarkCodec = .live
  ) {
    self.defaults = defaults
    legacyWorkspaceKey = "\(namespace).workspace"
    workspacesKey = "\(namespace).workspaces"
    recentsKey = "\(namespace).recents"
    self.maximumWorkspaceCount = max(1, maximumWorkspaceCount)
    self.maximumRecentCount = max(0, maximumRecentCount)
    self.codec = codec
  }

  func saveWorkspace(_ url: URL) throws {
    let newRecord = try record(for: url)
    var records = storedWorkspaceRecords()
    records.removeAll { $0.path == newRecord.path }
    records.insert(newRecord, at: 0)
    try save(Array(records.prefix(maximumWorkspaceCount)), key: workspacesKey)
    defaults.removeObject(forKey: legacyWorkspaceKey)
  }

  func restoreWorkspaces() -> [URL] {
    let storedRecords = storedWorkspaceRecords()
    var validRecords: [Record] = []
    var workspaceURLs: [URL] = []
    var restoredPaths: Set<String> = []

    for var record in storedRecords {
      do {
        let url = try resolve(&record)
        guard restoredPaths.insert(record.path).inserted else { continue }
        validRecords.append(record)
        workspaceURLs.append(url)
      } catch {
        continue
      }
    }

    try? save(Array(validRecords.prefix(maximumWorkspaceCount)), key: workspacesKey)
    defaults.removeObject(forKey: legacyWorkspaceKey)
    return Array(workspaceURLs.prefix(maximumWorkspaceCount))
  }

  func removeWorkspace(_ url: URL) {
    let path = url.standardizedFileURL.path(percentEncoded: false)
    var records = storedWorkspaceRecords()
    records.removeAll { $0.path == path }
    try? save(records, key: workspacesKey)
    defaults.removeObject(forKey: legacyWorkspaceKey)
  }

  func clearWorkspaces() {
    defaults.removeObject(forKey: legacyWorkspaceKey)
    defaults.removeObject(forKey: workspacesKey)
  }

  func recordRecentDocument(_ url: URL) throws {
    let newRecord = try record(for: url)
    var records: [Record] = load([Record].self, key: recentsKey) ?? []
    records.removeAll { $0.path == newRecord.path }
    records.insert(newRecord, at: 0)
    try save(Array(records.prefix(maximumRecentCount)), key: recentsKey)
  }

  func restoreRecentDocuments() -> [RecentDocument] {
    let storedRecords: [Record] = load([Record].self, key: recentsKey) ?? []
    var validRecords: [Record] = []
    var documents: [RecentDocument] = []
    var restoredPaths: Set<String> = []

    for var record in storedRecords {
      do {
        let url = try resolve(&record)
        guard
          MarkdownDocument.supports(url),
          restoredPaths.insert(record.path).inserted
        else { continue }
        validRecords.append(record)
        documents.append(
          RecentDocument(url: url, lastOpenedAt: record.lastOpenedAt)
        )
      } catch {
        continue
      }
    }

    try? save(Array(validRecords.prefix(maximumRecentCount)), key: recentsKey)
    return Array(documents.prefix(maximumRecentCount))
  }

  func removeRecentDocument(_ url: URL) {
    let path = url.standardizedFileURL.path(percentEncoded: false)
    var records: [Record] = load([Record].self, key: recentsKey) ?? []
    records.removeAll { $0.path == path }
    try? save(records, key: recentsKey)
  }

  func clearRecentDocuments() {
    defaults.removeObject(forKey: recentsKey)
  }

  private func record(for url: URL) throws -> Record {
    let standardizedURL = url.standardizedFileURL
    return Record(
      bookmarkData: try codec.create(url),
      path: standardizedURL.path(percentEncoded: false),
      displayName: standardizedURL.lastPathComponent,
      lastOpenedAt: Date()
    )
  }

  private func storedWorkspaceRecords() -> [Record] {
    if let records: [Record] = load([Record].self, key: workspacesKey) {
      return records
    }
    if let legacyRecord: Record = load(Record.self, key: legacyWorkspaceKey) {
      return [legacyRecord]
    }
    return []
  }

  private func resolve(_ record: inout Record) throws -> URL {
    let resolution = try codec.resolve(record.bookmarkData)
    let resolvedURL = resolution.url
    let standardizedURL = resolvedURL.standardizedFileURL

    if resolution.isStale {
      let access = SecurityScopedAccess(url: resolvedURL)
      record.bookmarkData = try codec.create(resolvedURL)
      withExtendedLifetime(access) {}
    }
    record.path = standardizedURL.path(percentEncoded: false)
    record.displayName = standardizedURL.lastPathComponent
    return resolvedURL
  }

  private func save<T: Encodable>(_ value: T, key: String) throws {
    defaults.set(try encoder.encode(value), forKey: key)
  }

  private func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
    guard let data = defaults.data(forKey: key) else { return nil }
    return try? decoder.decode(type, from: data)
  }
}

final class SecurityScopedAccess {
  let url: URL

  private let scopedURL: URL
  private let didStartAccessing: Bool

  init(url: URL) {
    scopedURL = url
    self.url = url.standardizedFileURL
    didStartAccessing = scopedURL.startAccessingSecurityScopedResource()
  }

  deinit {
    if didStartAccessing {
      scopedURL.stopAccessingSecurityScopedResource()
    }
  }
}
