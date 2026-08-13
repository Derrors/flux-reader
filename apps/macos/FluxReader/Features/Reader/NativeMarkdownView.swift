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
