import Foundation

struct WorkspaceNode: Identifiable, Equatable, Sendable {
  enum Kind: Equatable, Sendable {
    case folder
    case document
  }

  let url: URL
  let name: String
  let kind: Kind
  let children: [WorkspaceNode]

  var id: URL { url.standardizedFileURL }

  var outlineChildren: [WorkspaceNode]? {
    kind == .folder ? children : nil
  }
}

struct WorkspaceSnapshot: Identifiable, Equatable, Sendable {
  let rootURL: URL
  let children: [WorkspaceNode]
  let documentCount: Int

  var id: URL { rootURL.standardizedFileURL }
  var displayName: String { rootURL.lastPathComponent }

  var documentURLs: [URL] {
    func collect(_ nodes: [WorkspaceNode]) -> [URL] {
      nodes.flatMap { node in
        switch node.kind {
        case .folder:
          collect(node.children)
        case .document:
          [node.url]
        }
      }
    }
    return collect(children)
  }
}

struct RecentDocument: Identifiable, Equatable, Sendable {
  let url: URL
  let lastOpenedAt: Date

  var id: URL { url.standardizedFileURL }
  var displayName: String { url.lastPathComponent }
}

struct WorkspaceSearchResult: Identifiable, Equatable, Sendable {
  enum MatchKind: Equatable, Sendable {
    case fileName
    case content
  }

  let workspaceRootURL: URL
  let documentURL: URL
  let relativePath: String
  let snippet: String
  let matchKind: MatchKind

  var id: URL { documentURL.standardizedFileURL }
  var displayName: String { documentURL.lastPathComponent }
}
