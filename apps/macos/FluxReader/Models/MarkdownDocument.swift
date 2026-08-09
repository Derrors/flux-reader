import Foundation

struct MarkdownDocument: Identifiable, Equatable, Sendable {
  static let supportedFileExtensions: Set<String> = ["md", "markdown", "mdx"]

  let url: URL
  let content: String
  let byteCount: Int
  let modificationDate: Date?
  let resourceRootURL: URL?
  let resourceRevision: UUID

  init(
    url: URL,
    content: String,
    byteCount: Int,
    modificationDate: Date?,
    resourceRootURL: URL? = nil,
    resourceRevision: UUID = UUID()
  ) {
    self.url = url
    self.content = content
    self.byteCount = byteCount
    self.modificationDate = modificationDate
    self.resourceRootURL = resourceRootURL
    self.resourceRevision = resourceRevision
  }

  var id: URL { url.standardizedFileURL }
  var displayName: String { url.lastPathComponent }

  static func supports(_ url: URL) -> Bool {
    supportedFileExtensions.contains(url.pathExtension.lowercased())
  }

  func withResourceRoot(_ rootURL: URL?) -> MarkdownDocument {
    MarkdownDocument(
      url: url,
      content: content,
      byteCount: byteCount,
      modificationDate: modificationDate,
      resourceRootURL: rootURL?.standardizedFileURL,
      resourceRevision: resourceRevision
    )
  }
}
