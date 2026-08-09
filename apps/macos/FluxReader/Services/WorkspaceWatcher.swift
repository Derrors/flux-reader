import CoreServices
import Foundation

protocol WorkspaceWatchToken: AnyObject, Sendable {
  func cancel()
}

protocol WorkspaceWatching: Sendable {
  func watch(
    rootURL: URL,
    onChange: @escaping @Sendable () -> Void
  ) throws -> any WorkspaceWatchToken
}

enum WorkspaceWatcherError: LocalizedError, Equatable, Sendable {
  case unavailable
  case couldNotStart

  var errorDescription: String? {
    switch self {
    case .unavailable:
      "无法创建文件夹变化监听器。"
    case .couldNotStart:
      "文件夹变化监听器启动失败。"
    }
  }
}

struct FSEventWorkspaceWatcher: WorkspaceWatching {
  let latency: TimeInterval

  init(latency: TimeInterval = 0.25) {
    self.latency = latency
  }

  func watch(
    rootURL: URL,
    onChange: @escaping @Sendable () -> Void
  ) throws -> any WorkspaceWatchToken {
    try FSEventWorkspaceWatchToken(
      rootURL: rootURL,
      latency: latency,
      onChange: onChange
    )
  }
}

private final class WorkspaceWatcherCallbackBox: @unchecked Sendable {
  let onChange: @Sendable () -> Void

  init(onChange: @escaping @Sendable () -> Void) {
    self.onChange = onChange
  }
}

private final class FSEventWorkspaceWatchToken: WorkspaceWatchToken, @unchecked Sendable {
  private let lock = NSLock()
  private let callbackBox: WorkspaceWatcherCallbackBox
  private var stream: FSEventStreamRef?

  init(
    rootURL: URL,
    latency: TimeInterval,
    onChange: @escaping @Sendable () -> Void
  ) throws {
    callbackBox = WorkspaceWatcherCallbackBox(onChange: onChange)
    let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
      guard let info else { return }
      Unmanaged<WorkspaceWatcherCallbackBox>.fromOpaque(info)
        .takeUnretainedValue()
        .onChange()
    }
    var context = FSEventStreamContext(
      version: 0,
      info: Unmanaged.passUnretained(callbackBox).toOpaque(),
      retain: nil,
      release: nil,
      copyDescription: nil
    )
    let flags = FSEventStreamCreateFlags(
      kFSEventStreamCreateFlagFileEvents
        | kFSEventStreamCreateFlagNoDefer
        | kFSEventStreamCreateFlagWatchRoot
    )
    guard
      let stream = FSEventStreamCreate(
        nil,
        callback,
        &context,
        [rootURL.standardizedFileURL.path(percentEncoded: false)] as CFArray,
        FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
        latency,
        flags
      )
    else { throw WorkspaceWatcherError.unavailable }

    let queue = DispatchQueue(
      label: "com.derrors.fluxreader.workspace-watcher.\(UUID().uuidString)",
      qos: .utility
    )
    FSEventStreamSetDispatchQueue(stream, queue)
    guard FSEventStreamStart(stream) else {
      FSEventStreamInvalidate(stream)
      FSEventStreamRelease(stream)
      throw WorkspaceWatcherError.couldNotStart
    }
    self.stream = stream
  }

  func cancel() {
    lock.lock()
    let activeStream = stream
    stream = nil
    lock.unlock()

    guard let activeStream else { return }
    FSEventStreamStop(activeStream)
    FSEventStreamInvalidate(activeStream)
    FSEventStreamRelease(activeStream)
  }

  deinit {
    cancel()
  }
}
