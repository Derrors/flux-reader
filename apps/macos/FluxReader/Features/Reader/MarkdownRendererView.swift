import AppKit
import SwiftUI

struct MarkdownRendererView: View {
  let document: MarkdownDocument
  var findQuery = ""
  var findCaseSensitive = false
  var activeFindMatch = 0
  var targetScrollFraction: Double?
  var onScrollFractionChange: @MainActor (Double) -> Void = { _ in }

  @State private var usesNativeFallback = false

  var body: some View {
    VStack(spacing: 0) {
      if WebMarkdownView.rendererURL != nil && !usesNativeFallback {
        WebMarkdownView(
          document: document,
          findQuery: findQuery,
          findCaseSensitive: findCaseSensitive,
          activeFindMatch: activeFindMatch,
          targetScrollFraction: targetScrollFraction,
          onScrollFractionChange: onScrollFractionChange,
          onFailure: { usesNativeFallback = true }
        )
      } else {
        NativeMarkdownView(document: document)
      }

      Divider()

      DocumentStatusBar(document: document)
    }
    .onChange(of: document.id) { _, _ in
      usesNativeFallback = false
    }
  }
}

private struct DocumentStatusBar: View {
  let document: MarkdownDocument

  var body: some View {
    HStack(spacing: 12) {
      Text(document.url.path(percentEncoded: false))
        .lineLimit(1)
        .truncationMode(.middle)

      Spacer()

      Text(
        ByteCountFormatter.string(
          fromByteCount: Int64(document.byteCount),
          countStyle: .file
        )
      )
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
    .background(.bar)
  }
}
