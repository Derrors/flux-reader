import Foundation

/// Product-level limits shared by the native macOS host and the embedded reader.
/// Platform-specific UI remains native; only cross-platform product policy lives here.
enum ProductPolicy {
  static let maximumEditableDocumentBytes = 10 * 1_024 * 1_024
  static let maximumLocalImageBytes = 25 * 1_024 * 1_024
  static let maximumWorkspaceCount = 8
  static let maximumDocumentTabs = 12
  static let maximumRecentDocuments = 12
}
