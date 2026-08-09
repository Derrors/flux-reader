import UniformTypeIdentifiers

enum MarkdownContentType {
  static var allowedContentTypes: [UTType] {
    ["md", "markdown", "mdx"].compactMap {
      UTType(filenameExtension: $0, conformingTo: .plainText)
    }
  }
}
