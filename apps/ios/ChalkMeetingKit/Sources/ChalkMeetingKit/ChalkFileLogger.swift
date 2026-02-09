import Foundation

public enum ChalkLogLevel: String {
	case debug
	case info
	case error
}

public final class ChalkFileLogger: @unchecked Sendable {
	public static let shared = ChalkFileLogger()

	private let queue = DispatchQueue(label: "ai.q9labs.chalk.file-logger")
	private var dirUrl: URL?

	private init() {}

	public func configure(directory: URL? = nil) {
		queue.sync {
			if let directory {
				dirUrl = directory
				return
			}

			let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
			dirUrl = base?.appendingPathComponent("chalk-logs", isDirectory: true)
		}
	}

	public func log(_ level: ChalkLogLevel, _ message: String, meta: [String: String] = [:]) {
		queue.async { [weak self] in
			guard let self else { return }
			let dir = self.ensureDir()
			guard let dir else { return }

			let ts = ISO8601DateFormatter().string(from: Date())
			let metaStr = meta.isEmpty
				? ""
				: " " + meta
					.sorted(by: { $0.key < $1.key })
					.map { "\($0.key)=\($0.value)" }
					.joined(separator: " ")
			let line = "\(ts) level=\(level.rawValue)\(metaStr) msg=\(self.escape(message))\n"

			self.append(line, to: dir.appendingPathComponent("chalk.log"))
			if level == .debug { self.append(line, to: dir.appendingPathComponent("chalk.debug.log")) }
			if level == .error { self.append(line, to: dir.appendingPathComponent("chalk.error.log")) }
		}
	}

	public func files() -> [URL] {
		queue.sync {
			let dir = ensureDir()
			guard let dir else { return [] }
			return [
				dir.appendingPathComponent("chalk.log"),
				dir.appendingPathComponent("chalk.debug.log"),
				dir.appendingPathComponent("chalk.error.log"),
			].filter { FileManager.default.fileExists(atPath: $0.path) }
		}
	}

	public func clear() {
		queue.async { [weak self] in
			guard let self else { return }
			let dir = self.ensureDir()
			guard let dir else { return }
			for name in ["chalk.log", "chalk.debug.log", "chalk.error.log"] {
				try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
			}
		}
	}

	private func ensureDir() -> URL? {
		if dirUrl == nil { configure() }
		guard let dirUrl else { return nil }

		do {
			try FileManager.default.createDirectory(at: dirUrl, withIntermediateDirectories: true)
			return dirUrl
		} catch {
			return nil
		}
	}

	private func append(_ line: String, to url: URL) {
		let maxBytes = 5 * 1024 * 1024
		if let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue, size > maxBytes {
			try? FileManager.default.removeItem(at: url)
		}

		if !FileManager.default.fileExists(atPath: url.path) {
			try? line.data(using: .utf8)?.write(to: url, options: .atomic)
			return
		}

		guard let fh = try? FileHandle(forWritingTo: url) else { return }
		defer { try? fh.close() }
		do {
			try fh.seekToEnd()
			if let data = line.data(using: .utf8) {
				try fh.write(contentsOf: data)
			}
		} catch {
			// ignore
		}
	}

	private func escape(_ s: String) -> String {
		s
			.replacingOccurrences(of: "\\", with: "\\\\")
			.replacingOccurrences(of: "\n", with: "\\n")
			.replacingOccurrences(of: "\r", with: "\\r")
			.replacingOccurrences(of: "\t", with: "\\t")
	}
}

