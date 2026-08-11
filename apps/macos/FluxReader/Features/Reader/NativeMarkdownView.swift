import AppKit
import SwiftUI

struct NativeMarkdownView: View {
  let document: MarkdownDocument
  private let renderedContent: AttributedString

  init(document: MarkdownDocument) {
    self.document = document
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .full)
    self.renderedContent =
      (try? AttributedString(markdown: document.content, options: options))
      ?? AttributedString(document.content)
  }

  var body: some View {
    ScrollView {
      Text(renderedContent)
        .textSelection(.enabled)
        .frame(maxWidth: 860, alignment: .leading)
        .padding(.horizontal, 48)
        .padding(.vertical, 40)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
    .background(Color(nsColor: .textBackgroundColor))
  }
}

struct NativeMarkdownPlaceholderView: View {
  static let fullPreviewByteLimit = 512 * 1024
  static let excerptCharacterLimit = 64 * 1024

  let document: MarkdownDocument
  private let renderedContent: AttributedString
  private let isExcerpt: Bool

  init(document: MarkdownDocument) {
    self.document = document
    isExcerpt = document.byteCount > Self.fullPreviewByteLimit
    let source =
      isExcerpt
      ? String(document.content.prefix(Self.excerptCharacterLimit))
      : document.content
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .full)
    renderedContent =
      (try? AttributedString(markdown: source, options: options))
      ?? AttributedString(source)
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if isExcerpt {
          Label("正在加载完整 Web 预览，暂时显示文稿开头", systemImage: "hourglass")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Text(renderedContent)
          .textSelection(.enabled)
      }
      .frame(maxWidth: 860, alignment: .leading)
      .padding(.horizontal, 48)
      .padding(.vertical, 40)
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
    .background(Color(nsColor: .textBackgroundColor))
  }
}
